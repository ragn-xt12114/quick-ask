export function prioritizeCurrentSession<T extends { id: string }>(
  sessions: T[],
  currentSessionId: string | null,
  offset = 0
): T[] {
  if (currentSessionId === null || offset !== 0) return sessions
  const index = sessions.findIndex((session) => session.id === currentSessionId)
  if (index <= 0) return sessions
  return [sessions[index]!, ...sessions.slice(0, index), ...sessions.slice(index + 1)]
}
