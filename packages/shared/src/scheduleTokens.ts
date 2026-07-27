/** Replaces `{{date}}` and `{{counter}}` tokens in a template string using the schedule's timezone and run count. */
export function substituteTokens(
  template: string,
  context: { runCount: number; timezone: string; scheduledFor?: string },
): string {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: context.timezone,
  }).format(context.scheduledFor ? new Date(context.scheduledFor) : new Date());
  return template.replaceAll("{{date}}", date).replaceAll("{{counter}}", String(context.runCount));
}
