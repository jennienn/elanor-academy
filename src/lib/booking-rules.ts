import { WEEKS_BY_PLAN, addCalendarDays } from "@/lib/business-rules";

export const BOOKING_FIRST_START_MINUTE = 600;
export const BOOKING_LAST_START_MINUTE = 1320;

export function bookingTimeSlots(): number[] {
  return Array.from(
    { length: (BOOKING_LAST_START_MINUTE - BOOKING_FIRST_START_MINUTE) / 30 + 1 },
    (_, index) => BOOKING_FIRST_START_MINUTE + index * 30
  );
}

export function soloBookingValidEnd(
  paymentDate: string,
  plan: number | null,
  validWeeks = plan === null ? undefined : WEEKS_BY_PLAN[plan as keyof typeof WEEKS_BY_PLAN]
): string {
  if (validWeeks === undefined) {
    throw new Error("개인레슨 예약 유효 기간을 확인해주세요.");
  }
  return addCalendarDays(paymentDate, validWeeks * 7 - 1);
}

export function advanceNoticeUnavailableSlots(selectedDate: string, today: string, currentMinute: number) {
  if (selectedDate !== today) return [];
  const minimumStart = currentMinute + 120;
  const unavailable: number[] = [];
  for (const slot of bookingTimeSlots()) {
    if (slot < minimumStart) unavailable.push(slot);
  }
  return unavailable;
}

export function lateCancellationCharges(bookingDate: string, today: string, currentMinute: number): boolean {
  const cancellationDeadlineDate = addCalendarDays(bookingDate, -1);
  return today > cancellationDeadlineDate || (today === cancellationDeadlineDate && currentMinute >= 20 * 60);
}

export function isBookingDateWithinRange(date: string, firstBookableDate: string, validEndDate: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= firstBookableDate && date <= validEndDate;
}
