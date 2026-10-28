export class AppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppError';
  }
}

export class ConfigError extends AppError {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export class RuleError extends AppError {
  constructor(message: string) {
    super(message);
    this.name = 'RuleError';
  }
}

export class ChatResolveError extends AppError {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ChatResolveError';
    this.code = code;
  }
}
