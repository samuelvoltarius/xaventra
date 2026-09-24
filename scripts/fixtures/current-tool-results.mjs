// OpenAI-compatible scripted provider: only correlated results of this user turn.
export function currentToolResults(messages) {
  const start = messages.findLastIndex(message => message.role === 'user')
  const calls = new Set()
  const results = []
  for (const message of messages.slice(start + 1)) {
    if (message.role === 'assistant') for (const call of message.tool_calls || []) calls.add(call.id)
    if (message.role === 'tool' && calls.has(message.tool_call_id)) results.push(String(message.content))
  }
  return results.join('\n')
}
