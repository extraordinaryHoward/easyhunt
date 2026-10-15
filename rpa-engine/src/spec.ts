import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type Parameter = { option: string; field?: string; required?: boolean; default?: unknown; source?: string };
export type Command = {
  action: string;
  execution: string;
  method: string;
  path: string;
  result: string;
  parameters: Parameter[];
  platforms: string[];
  confirmation?: boolean;
};

const specUrl = new URL('../../docs/RPA引擎-命令规格.json', import.meta.url);
// src/ sits below rpa-engine/; the checked-in specification is the single source of truth.
export const commands = JSON.parse(readFileSync(fileURLToPath(specUrl), 'utf8')) as Command[];
export const byAction = new Map(commands.map((command) => [command.action, command]));

export class ApiError extends Error {
  constructor(public statusCode: number, public code: string, message: string) {
    super(message);
  }
}

export function objectBody(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(400, 'INVALID_BODY', 'JSON object body required');
  }
  return value as Record<string, unknown>;
}

export function validate(command: Command, input: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...input };
  for (const parameter of command.parameters) {
    const field = parameter.field ?? camelCase(parameter.option);
    const value = normalized[field];
    if (value === undefined && parameter.default !== undefined) normalized[field] = parameter.default;
    if (parameter.required && (normalized[field] === undefined || normalized[field] === null || normalized[field] === '')) {
      throw new ApiError(400, 'MISSING_PARAMETER', `${field} is required`);
    }
    if (normalized[field] !== undefined && normalized[field] !== null) {
      if (parameter.source === 'json-file' && (typeof normalized[field] !== 'object' || Array.isArray(normalized[field]))) {
        throw new ApiError(400, 'INVALID_PARAMETER', `${field} must be a JSON object`);
      }
      if (field === 'confirmed' && typeof normalized[field] !== 'boolean') {
        throw new ApiError(400, 'INVALID_PARAMETER', 'confirmed must be a boolean');
      }
    }
  }
  if (command.platforms.length > 0 && normalized.platform !== undefined && !command.platforms.includes(String(normalized.platform))) {
    throw new ApiError(400, 'UNSUPPORTED_PLATFORM', `platform is not supported for ${command.action}`);
  }
  if (command.confirmation && normalized.confirmed !== true) {
    throw new ApiError(400, 'CONFIRMATION_REQUIRED', 'confirmed must be true');
  }
  return normalized;
}

function camelCase(value: string): string {
  return value.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}
