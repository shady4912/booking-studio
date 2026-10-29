export function collectBookingAnswers(project, entries) {
  const fieldIds = new Set(
    project.sections.flatMap((section) => section.fields || []).map((field) => field.id),
  );
  return new Map(
    [...entries]
      .filter(([id]) => fieldIds.has(id))
      .map(([id, value]) => [id, String(value)]),
  );
}
