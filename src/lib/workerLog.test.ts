import { describe, it, expect } from "vitest";
import { normalizeWorkerLog } from "./workerLog";

describe("normalizeWorkerLog", () => {
  it("unwraps Kaggle JSON-array logs", () => {
    const raw = JSON.stringify([
      { stream_name: "stdout", time: 1, data: 'RCLONEFLIX_TG_OFFLOAD_RESULT:{"msgId":1,"name":"a"}\n' },
    ]);
    expect(normalizeWorkerLog(raw)).toContain('RCLONEFLIX_TG_OFFLOAD_RESULT:{"msgId":1,"name":"a"}');
  });
  it("preserves lines split across multiple Kaggle stdout events", () => {
    const raw = JSON.stringify([
      { stream_name: "stdout", time: 1, data: 'RCLONEFLIX_TG_OFFLOAD_RESULT:{"msgId":1,' },
      { stream_name: "stdout", time: 2, data: '"name":"split"}\n' },
    ]);
    expect(normalizeWorkerLog(raw)).toBe('RCLONEFLIX_TG_OFFLOAD_RESULT:{"msgId":1,"name":"split"}\n');
  });
  it("passes plain text through", () => {
    expect(normalizeWorkerLog("hello\nworld")).toBe("hello\nworld");
  });
  it("recovers from a truncated array", () => {
    const raw = '[{"stream_name":"stdout","data":"x\\n"},{"stream_name":"stdout","data":"y\\n"';
    expect(normalizeWorkerLog(raw)).toBe("x\ny\n");
  });
});
