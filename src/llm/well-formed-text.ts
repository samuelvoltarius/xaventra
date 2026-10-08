/**
 * A lone UTF-16 surrogate (a character cut in half by some `slice`) cannot be encoded by the model
 * server's tokenizer: vLLM answers 400 "TextEncodeInput must be …" for the whole request, on every
 * endpoint. Every text that leaves for a model is made well-formed first.
 */
export function wellFormed<T>(value: T): T {
    return (typeof value === 'string' && typeof (value as any).toWellFormed === 'function' ? (value as any).toWellFormed() : value) as T
}
