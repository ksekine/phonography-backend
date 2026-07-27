import { describe, expect, test } from "bun:test";
import { canView, type RecordingRow } from "./recordings";

/**
 * canView() の真理値表を固定する。
 * visibleToSql() は同じ表を SQL で表現したものなので、ここを変更したときは
 * 必ず visibleToSql() も合わせること(D1 なしでは SQL 側を単体テストできない)。
 */

const OWNER = "owner-uid";
const OTHER = "other-uid";
const ANONYMOUS = ""; // optionalAuth が未認証に割り当てる値

function row(
  status: RecordingRow["status"],
  visibility: RecordingRow["visibility"]
): RecordingRow {
  return {
    id: "4b55ae5d-4f7f-4fc1-a09d-4ca7e3f2f6bd",
    userId: OWNER,
    status,
    visibility,
  } as RecordingRow;
}

describe("canView", () => {
  test("lets the owner see everything but a deleted recording", () => {
    expect(canView(row("pending", "private"), OWNER)).toBe(true);
    expect(canView(row("ready", "private"), OWNER)).toBe(true);
    expect(canView(row("ready", "public"), OWNER)).toBe(true);
    expect(canView(row("hidden", "public"), OWNER)).toBe(true);
    expect(canView(row("deleted", "public"), OWNER)).toBe(false);
  });

  test("lets others see only a ready public recording", () => {
    expect(canView(row("ready", "public"), OTHER)).toBe(true);
    expect(canView(row("ready", "private"), OTHER)).toBe(false);
    expect(canView(row("pending", "public"), OTHER)).toBe(false);
    expect(canView(row("hidden", "public"), OTHER)).toBe(false);
    expect(canView(row("deleted", "public"), OTHER)).toBe(false);
  });

  test("treats an anonymous caller the same as any other user", () => {
    expect(canView(row("ready", "public"), ANONYMOUS)).toBe(true);
    expect(canView(row("ready", "private"), ANONYMOUS)).toBe(false);
    expect(canView(row("hidden", "public"), ANONYMOUS)).toBe(false);
    expect(canView(row("deleted", "public"), ANONYMOUS)).toBe(false);
  });
});
