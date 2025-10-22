import fs from "fs";
import path from "path";

export type LogLevel = "error" | "warn" | "info" | "debug";

const levelWeights: Record<LogLevel, number> = {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3,
};

export interface LoggerOptions {
    level?: LogLevel;
    file?: string;
}

interface LogPayload {
    message: string;
    context?: Record<string, unknown>;
    error?: unknown;
}

function serialize(value: unknown): string {
    if (value instanceof Error) {
        return JSON.stringify({
            message: value.message,
            stack: value.stack,
            name: value.name,
        });
    }

    if (typeof value === "object") {
        try {
            return JSON.stringify(value);
        } catch (err) {
            return String(value);
        }
    }

    return String(value);
}

class EnterpriseLogger {
    private level: LogLevel = "info";
    private file?: string;
    private stream?: fs.WriteStream;

    configure(options: LoggerOptions = {}) {
        if (options.level) {
            this.level = options.level;
        }

        if (options.file) {
            this.configureFile(options.file);
        }
    }

    private configureFile(file: string) {
        this.file = path.resolve(file);
        const directory = path.dirname(this.file);
        fs.mkdirSync(directory, { recursive: true });
        if (this.stream) {
            this.stream.end();
        }
        this.stream = fs.createWriteStream(this.file, { flags: "a" });
    }

    private shouldLog(level: LogLevel) {
        return levelWeights[level] <= levelWeights[this.level];
    }

    private write(level: LogLevel, payload: LogPayload) {
        if (!this.shouldLog(level)) {
            return;
        }

        const timestamp = new Date().toISOString();
        const context = payload.context ? ` ${serialize(payload.context)}` : "";
        const error = payload.error ? ` ${serialize(payload.error)}` : "";
        const line = `[${timestamp}] [${level.toUpperCase()}] ${payload.message}${context}${error}`;

        if (level === "error") {
            // eslint-disable-next-line no-console
            console.error(line);
        } else if (level === "warn") {
            // eslint-disable-next-line no-console
            console.warn(line);
        } else {
            // eslint-disable-next-line no-console
            console.log(line);
        }

        if (this.stream) {
            this.stream.write(`${line}\n`);
        }
    }

    error(message: string, meta?: Record<string, unknown> | Error, error?: unknown) {
        if (meta instanceof Error) {
            this.write("error", { message, error: meta });
            return;
        }
        this.write("error", { message, context: meta, error });
    }

    warn(message: string, meta?: Record<string, unknown>) {
        this.write("warn", { message, context: meta });
    }

    info(message: string, meta?: Record<string, unknown>) {
        this.write("info", { message, context: meta });
    }

    debug(message: string, meta?: Record<string, unknown>) {
        this.write("debug", { message, context: meta });
    }
}

export const logger = new EnterpriseLogger();

export function setLoggerOptions(options: LoggerOptions) {
    logger.configure(options);
}
