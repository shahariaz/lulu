const subscribers = new Set()

export function subscribeToOrchestratorEvents(listener) {
  subscribers.add(listener)
  return () => subscribers.delete(listener)
}

export function broadcastOrchestratorEvent(eventType, data = {}) {
  for (const listener of subscribers) {
    try { listener(eventType, data) } catch { subscribers.delete(listener) }
  }
}
