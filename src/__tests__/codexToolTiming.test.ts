import { describe, expect, it } from "vitest";
import { parseCodexJSONL } from "../lib/codexParser";
import { parseSession } from "../lib/parseSession";
import { appendLiveSessionText, createLiveSessionParser } from "../lib/liveSessionParser";
import { buildWaterfallItems, getWaterfallStats } from "../lib/waterfall";

const stamp = (seconds: number) => new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString();
const encode = (records: unknown[]) => records.map(record => JSON.stringify(record)).join("\n");
const meta = { type: "session_meta", payload: { originator: "codex-cli" } };
const record = (seconds: number, payload: Record<string, unknown>, type = "response_item") => ({ type, timestamp: stamp(seconds), payload });
const call = (seconds: number, id: string, type = "function_call") => record(seconds, { type, call_id: id, name: "exec_command", arguments: "{}", input: "patch" });
const result = (seconds: number, id: string, type = "function_call_output", output = "ok") => record(seconds, { type, call_id: id, output });
const tools = (text: string) => parseCodexJSONL(text)!.events.filter(event => event.track === "tool_call");

describe("Codex observed tool durations", () => {
  it.each([
    ["function_call", "function_call_output", "response_item"],
    ["custom_tool_call", "custom_tool_call_output", "response_item"],
    ["custom_tool_call", "patch_apply_end", "event_msg"],
  ])("measures %s through %s from raw timestamps", (callType, resultType, resultRecordType) => {
    const rows = [meta, call(1, "a", callType), record(2, { type: "reasoning", summary: "interleaved" }), { ...result(6, "a", resultType), type: resultRecordType }];
    const text = encode(rows);
    expect(tools(text)[0].duration).toBe(5);
    expect(parseSession(text)!.events.find(event => event.track === "tool_call")!.duration).toBe(5);
    let live = createLiveSessionParser("");
    for (let i = 0; i < rows.length; i++) {
      live = appendLiveSessionText(live, encode([rows[i]])).state;
      expect(live.result).toEqual(parseSession(encode(rows.slice(0, i + 1))));
    }
  });

  it("measures overlapping calls independently and preserves result order", () => {
    const rows = [meta, call(1, "a"), call(2, "b"), result(4, "b"), result(8, "a"), result(6, "a", "function_call_output", "backdated")];
    const text = encode(rows);
    expect(tools(text).map(event => event.duration)).toEqual([7, 2]);
    const parsed = parseSession(text)!;
    expect(getWaterfallStats(buildWaterfallItems(parsed.events)).maxConcurrency).toBe(2);
    expect(parsed.events.find(event => event.toolCallId === "a" && event.track === "tool_call")!.toolOutput).toContain("ok");
    let live = createLiveSessionParser("");
    for (let i = 0; i < rows.length; i++) {
      live = appendLiveSessionText(live, encode([rows[i]])).state;
      expect(live.result).toEqual(parseSession(encode(rows.slice(0, i + 1))));
    }
  });

  it("retains zero and subsecond intervals without the display minimum", () => {
    for (const elapsed of [0, 0.025, 5, 600]) {
      const rows = [meta, call(1, "a"), result(1 + elapsed, "a")];
      expect(tools(encode(rows))[0].duration).toBeCloseTo(elapsed, 5);
      let live = createLiveSessionParser(encode(rows.slice(0, 2)));
      const snapshot = live.result;
      live = appendLiveSessionText(live, encode(rows.slice(2))).state;
      expect(live.result).toEqual(parseSession(encode(rows)));
      expect(snapshot!.events[0].duration).toBe(0.5);
    }
  });

  it("keeps the fallback when a measured interval is unavailable", () => {
    const cases = [
      [meta, call(1, "a")],
      [meta, { ...call(1, "a"), timestamp: undefined }, result(6, "a")],
      [meta, call(1, "a"), { ...result(6, "a"), timestamp: "invalid" }],
      [meta, call(6, "a"), result(1, "a")],
    ];
    for (const rows of cases) {
      expect(tools(encode(rows))[0].duration).toBe(0.5);
      let live = createLiveSessionParser("");
      for (const row of rows) live = appendLiveSessionText(live, encode([row])).state;
      expect(live.result).toEqual(parseSession(encode(rows)));
    }
  });

  it("associates a web search completion with its original call timestamp", () => {
    const rows = [meta, record(1, { type: "web_search_call", action: { query: "docs" } }), record(6, { type: "web_search_end", call_id: "web", query: "docs" }, "event_msg")];
    expect(tools(encode(rows))[0].duration).toBe(5);
    let live = createLiveSessionParser(encode(rows.slice(0, 2)));
    live = appendLiveSessionText(live, encode(rows.slice(2))).state;
    expect(live.result).toEqual(parseSession(encode(rows)));
  });

  it.each([false, true])("updates a completed earlier turn with lifecycle=%s", lifecycle => {
    const rows = [meta,
      ...(lifecycle ? [record(0, { type: "task_started", turn_id: "first" }, "event_msg")] : []),
      call(1, "a"),
      ...(lifecycle ? [record(2, { type: "task_started", turn_id: "second" }, "event_msg")] : []),
      record(2, { type: "message", role: "user", content: "next turn" }),
      result(6, "a"),
      result(9, "a", "function_call_output", "updated output"),
    ];
    let live = createLiveSessionParser("");
    for (let i = 0; i < rows.length; i++) {
      live = appendLiveSessionText(live, encode([rows[i]])).state;
      expect(live.result).toEqual(parseSession(encode(rows.slice(0, i + 1))));
    }
    expect(live.result!.turns[0].endTime).toBeCloseTo(8, 5);
  });

  it("updates one late completion with bounded work after large histories", () => {
    const work = [100, 5000].map(size => {
      const rows = [meta, call(1, "a"), ...Array.from({ length: size }, (_, i) => record(i + 2, { type: "message", role: "assistant", content: "working" }))];
      let live = createLiveSessionParser(encode(rows), { snapshot: false });
      const membership = live.result!.turns[0].eventIndices;
      live = appendLiveSessionText(live, encode([result(size + 3, "a")])).state;
      expect(live.result!.turns[0].eventIndices).toBe(membership);
      expect(live.result).toEqual(parseSession(live.rawText));
      return live.normalizationWork;
    });
    expect(work[1].events).toBeLessThanOrEqual(work[0].events + 2);
    expect(work[1].turns).toBeLessThanOrEqual(work[0].turns + 2);
  });
});
