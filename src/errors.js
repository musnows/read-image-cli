export class ReadImageError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "ReadImageError";
    this.code = code;
  }
}

export function asReadImageError(error) {
  if (error instanceof ReadImageError) {
    return error;
  }

  return new ReadImageError("INTERNAL_ERROR", "An unexpected error occurred.", {
    cause: error,
  });
}
