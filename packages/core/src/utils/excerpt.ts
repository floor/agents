/**
 * A long output, cut to fit — keeping its end.
 *
 * A process says why it failed in its last lines. Every error in the engine used
 * to keep the *first* 500 characters instead: when Codex ran out of quota, the
 * pull request showed its start-up banner and the beginning of the prompt, and
 * the one line that mattered — "You've hit your usage limit" — was cut off
 * (vlist #259, mtrl #91). A quarter of the room goes to the head, for what was
 * run; the rest goes to the tail, for what happened.
 */
export function excerpt(text: string, max = 1_500): string {
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed
  const head = Math.floor(max / 4)
  const tail = max - head
  const omitted = trimmed.length - max
  return `${trimmed.slice(0, head)}\n[… ${omitted} characters omitted …]\n${trimmed.slice(-tail)}`
}

/**
 * The same cut for a stream that may never fit in memory: the head is kept as it
 * arrives, the tail in a window that slides.
 */
export function createExcerptBuffer(headLimit: number, tailLimit: number): {
  push(text: string): void
  text(): string
} {
  let head = ''
  let tail = ''
  let seen = 0
  return {
    push(text) {
      seen += text.length
      const room = headLimit - head.length
      if (room > 0) {
        head += text.slice(0, room)
        text = text.slice(room)
      }
      if (!text) return
      tail += text
      if (tail.length > tailLimit * 2) tail = tail.slice(-tailLimit)
    },
    text() {
      const end = tail.slice(-tailLimit)
      const omitted = seen - head.length - end.length
      return omitted > 0 ? `${head}\n[… ${omitted} characters omitted …]\n${end}` : head + end
    },
  }
}
