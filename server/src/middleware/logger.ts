import path from "node:path";
import fs from "node:fs";
import pino from "pino";
import { pinoHttp } from "pino-http";
import { readConfigFile } from "../config-file.js";
import { resolveDefaultLogsDir, resolveHomeAwarePath } from "../home-paths.js";

function resolveServerLogDir(): string {
  const envOverride = process.env.PAPERCLIP_LOG_DIR?.trim();
  if (envOverride) return resolveHomeAwarePath(envOverride);

  const fileLogDir = readConfigFile()?.logging.logDir?.trim();
  if (fileLogDir) return resolveHomeAwarePath(fileLogDir);

  return resolveDefaultLogsDir();
}

const logDir = resolveServerLogDir();
fs.mkdirSync(logDir, { recursive: true });

const logFile = path.join(logDir, "server.log");

const sharedOpts = {
  translateTime: "HH:MM:ss",
  ignore: "pid,hostname",
  singleLine: true,
};

const optionalIssueDocumentKeys = new Set([
  "atlas-execution",
  "fingerprint",
  "incident-fingerprint",
  "source-reference",
]);

function routePath(req: unknown): string | null {
  const path = (req as { route?: { path?: unknown } } | null)?.route?.path;
  return typeof path === "string" ? path : null;
}

function requestMethod(req: unknown): string | null {
  const method = (req as { method?: unknown } | null)?.method;
  return typeof method === "string" ? method.toUpperCase() : null;
}

function requestParam(req: unknown, key: string): string | null {
  const value = (req as { params?: Record<string, unknown> } | null)?.params?.[key];
  return typeof value === "string" ? value.trim().toLowerCase() : null;
}

export function isExpectedMissingIssueDocument(req: unknown, statusCode: number): boolean {
  if (statusCode !== 404) return false;
  if (requestMethod(req) !== "GET") return false;
  if (routePath(req) !== "/issues/:id/documents/:key") return false;
  const key = requestParam(req, "key");
  return !!key && optionalIssueDocumentKeys.has(key);
}

export function httpRequestLogLevel(req: unknown, statusCode: number, err?: unknown) {
  if (err || statusCode >= 500) return "error";
  if (isExpectedMissingIssueDocument(req, statusCode)) return "debug";
  if (statusCode >= 400) return "warn";
  return "info";
}

export const logger = pino({
  level: "debug",
}, pino.transport({
  targets: [
    {
      target: "pino-pretty",
      options: { ...sharedOpts, ignore: "pid,hostname,req,res,responseTime", colorize: true, destination: 1 },
      level: "info",
    },
    {
      target: "pino-pretty",
      options: { ...sharedOpts, colorize: false, destination: logFile, mkdir: true },
      level: "debug",
    },
  ],
}));

export const httpLogger = pinoHttp({
  logger,
  customLogLevel(_req, res, err) {
    return httpRequestLogLevel(_req, res.statusCode, err);
  },
  customSuccessMessage(req, res) {
    return `${req.method} ${req.url} ${res.statusCode}`;
  },
  customErrorMessage(req, res, err) {
    const ctx = (res as any).__errorContext;
    const errMsg = ctx?.error?.message || err?.message || (res as any).err?.message || "unknown error";
    return `${req.method} ${req.url} ${res.statusCode} — ${errMsg}`;
  },
  customProps(req, res) {
    if (res.statusCode >= 400) {
      const ctx = (res as any).__errorContext;
      if (ctx) {
        return {
          errorContext: ctx.error,
          reqBody: ctx.reqBody,
          reqParams: ctx.reqParams,
          reqQuery: ctx.reqQuery,
        };
      }
      const props: Record<string, unknown> = {};
      const { body, params, query } = req as any;
      if (body && typeof body === "object" && Object.keys(body).length > 0) {
        props.reqBody = body;
      }
      if (params && typeof params === "object" && Object.keys(params).length > 0) {
        props.reqParams = params;
      }
      if (query && typeof query === "object" && Object.keys(query).length > 0) {
        props.reqQuery = query;
      }
      if ((req as any).route?.path) {
        props.routePath = (req as any).route.path;
      }
      return props;
    }
    return {};
  },
});
