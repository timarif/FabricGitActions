const VARIABLE_PATTERN = /\$\{var\.([A-Z_][A-Z0-9_]*)\}/g;

export function substituteVariables(
  value: unknown,
  variables: Record<string, string>,
): unknown {
  if (typeof value === "string") {
    return value.replace(VARIABLE_PATTERN, (_match, variableName: string) => {
      const replacement = variables[variableName];
      if (replacement === undefined) {
        throw new Error(`Required deployment variable ${variableName} is not set.`);
      }
      return replacement;
    });
  }

  if (Array.isArray(value)) {
    return value.map((entry) => substituteVariables(entry, variables));
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [
        key,
        substituteVariables(entryValue, variables),
      ]),
    );
  }

  return value;
}
