// 규칙 엔진 코어 공개 API. 나중에 DB/API/UI 계층이 여기서 import 한다.
export * from "./types.ts";
export { DEFAULT_SETTINGS } from "./settings.ts";
export { judgeAttendance } from "./attendance.ts";
export { evaluateSession } from "./warnings.ts";
export {
  computeWeeklyFine,
  computeSettlement,
  type WeeklyFineResult,
  type SettlementResult,
} from "./fines.ts";
export { evaluateAutoExit, type MemberStatus } from "./autoExit.ts";
export {
  buildSessionTiming,
  type TimeWindow,
  type PresenceEvent,
} from "./sessionWindow.ts";
export { weekStartMonday, consecutiveFineWeeks } from "./weekly.ts";
export {
  validateRoomSettings,
  type SettingsValidationResult,
} from "./validation.ts";
