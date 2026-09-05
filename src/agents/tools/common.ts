export function createActionGate(actions: Record<string, boolean> | undefined) {
  return (name: string, defaultValue = true): boolean => {
    const value = actions?.[name];
    return typeof value === "boolean" ? value : defaultValue;
  };
}

export function readStringParam(
  params: Record<string, unknown>,
  key: string,
  options: { required?: boolean; allowEmpty?: boolean; trim?: boolean } = {},
): string | undefined {
  const value = params[key];
  if (value === undefined || value === null) {
    if (options.required) throw new Error(`${key} is required.`);
    return undefined;
  }
  if (typeof value !== "string") throw new Error(`${key} must be a string.`);
  const result = options.trim === false ? value : value.trim();
  if (!result && options.required && !options.allowEmpty) throw new Error(`${key} is required.`);
  if (!result && !options.allowEmpty) return undefined;
  return result;
}

export function readStringOrNumberParam(
  params: Record<string, unknown>,
  key: string,
): string | number | undefined {
  const value = params[key];
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number") return value;
  return undefined;
}

export function readNumberParam(
  params: Record<string, unknown>,
  key: string,
  options: { integer?: boolean; required?: boolean } = {},
): number | undefined {
  const value = params[key];
  if (value === undefined || value === null || value === "") {
    if (options.required) throw new Error(`${key} is required.`);
    return undefined;
  }
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue)) throw new Error(`${key} must be a number.`);
  if (options.integer && !Number.isInteger(numberValue)) throw new Error(`${key} must be an integer.`);
  return numberValue;
}

export function readStringArrayParam(
  params: Record<string, unknown>,
  key: string,
  options: { required?: boolean; label?: string } = {},
): string[] | undefined {
  const value = params[key];
  if (value === undefined || value === null) {
    if (options.required) throw new Error(`${options.label ?? key} is required.`);
    return undefined;
  }
  const values = Array.isArray(value) ? value : [value];
  const result = values
    .map((entry) => (typeof entry === "string" || typeof entry === "number" ? String(entry).trim() : ""))
    .filter(Boolean);
  if (options.required && result.length === 0) throw new Error(`${options.label ?? key} is required.`);
  return result;
}
