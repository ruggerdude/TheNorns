const GENERIC_LOCAL_REPOSITORY_NAME = "Local repository";

export function safeLocalRepositoryDisplayName(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  const hasUnsafeCharacter = [...trimmed].some((character) => {
    const code = character.charCodeAt(0);
    return character === "/" || character === "\\" || code < 32 || code === 127;
  });
  return trimmed.length > 0 && trimmed.length <= 240 && !hasUnsafeCharacter
    ? trimmed
    : GENERIC_LOCAL_REPOSITORY_NAME;
}
