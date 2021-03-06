import chalk from 'chalk';
import * as path from 'path';
import { serializeError } from 'serialize-error';
import format from 'string-format';
import winston, { LogEntry, Logger } from 'winston';
import yn from 'yn';

import { Analytics } from '../analytics/analytics';
import { getSync } from '../api/consumer/lib/global-config';
import defaultHandleError from '../cli/default-error-handler';
import { CFG_LOG_JSON_FORMAT, CFG_LOG_LEVEL, CFG_NO_WARNINGS, DEBUG_LOG, GLOBAL_LOGS } from '../constants';

// Store the extensionsLoggers to prevent create more than one logger for the same extension
// in case the extension developer use api.logger more than once
const extensionsLoggers = new Map();

const jsonFormat = yn(getSync(CFG_LOG_JSON_FORMAT), { default: false });

const logLevel = getSync(CFG_LOG_LEVEL) || 'debug';

// eslint-disable-next-line @typescript-eslint/interface-name-prefix
export interface IBitLogger {
  silly(message: string, ...meta: any[]): void;

  debug(message: string, ...meta: any[]): void;

  warn(message: string, ...meta: any[]): void;

  info(message: string, ...meta: any[]): void;

  error(message: string, ...meta: any[]): void;

  console(msg: string): void;
}

export const baseFileTransportOpts = {
  filename: DEBUG_LOG,
  format: jsonFormat ? winston.format.combine(winston.format.timestamp(), winston.format.json()) : getFormat(),
  level: logLevel,
  maxsize: 10 * 1024 * 1024, // 10MB
  maxFiles: 10,
  // If true, log files will be rolled based on maxsize and maxfiles, but in ascending order.
  // The filename will always have the most recent log lines. The larger the appended number, the older the log file
  tailable: true,
};

function getMetadata(info) {
  if (!Object.keys(info.metadata).length) return '';
  if ((info.level === 'error' || info.level === '\u001b[31merror\u001b[39m') && info.metadata.stack) {
    // this is probably an instance of Error, show the stack nicely and not serialized.
    return `\n${info.metadata.stack}`;
  }
  try {
    return JSON.stringify(info.metadata, null, 2);
  } catch (err) {
    return `logger error: logging failed to stringify the metadata Json. (error: ${err.message})`;
  }
}

export function getFormat() {
  return winston.format.combine(
    winston.format.metadata(),
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.splat(), // does nothing?
    winston.format.errors({ stack: true }),
    winston.format.prettyPrint({ depth: 3, colorize: true }), // does nothing?
    winston.format.printf((info) => `${info.timestamp} ${info.level}: ${info.message} ${getMetadata(info)}`)
  );
}

const exceptionsFileTransportOpts = Object.assign({}, baseFileTransportOpts, {
  filename: path.join(GLOBAL_LOGS, 'exceptions.log'),
});

/**
 * the method signatures of debug/info/error/etc are similar to Winston.logger.
 * the way how it is formatted in the log file is according to the `customPrint` function above.
 *
 * Note about logging Error objects (with stacktrace).
 * when throwing an error in the code, it shows it formatted nicely in the log. and also in the console when
 * BIT_LOG is used.
 * when using logger.error(error), it shows undefined, because it expects a message as the first parameter.
 * when using logger.error(message, error), it shows the error serialized and unclear.
 * normally, no need to call logger.error(). once an error is thrown, it is already logged.
 */
class BitLogger implements IBitLogger {
  logger: Logger;
  /**
   * being set on command-registrar, once the flags are parsed. here, it's a workaround to have
   * it set before the command-registrar is loaded. at this stage we don't know for sure the "-j"
   * is actually "json". that's why this variable is overridden once the command-registrar is up.
   */
  shouldWriteToConsole = !process.argv.includes('--json') && !process.argv.includes('-j');

  constructor(logger: Logger) {
    this.logger = logger;
    logger.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.log('got an error from the logger', err);
    });
  }

  silly(message: string, ...meta: any[]) {
    this.logger.silly(message, ...meta);
  }

  debug(message: string, ...meta: any[]) {
    this.logger.debug(message, ...meta);
  }

  warn(message: string, ...meta: any[]) {
    this.logger.warn(message, ...meta);
  }

  info(message: string, ...meta: any[]) {
    this.logger.info(message, ...meta);
  }

  error(message: string, ...meta: any[]) {
    this.logger.error(message, ...meta);
  }

  /**
   * use this instead of calling `console.log()`, this way it won't break commands that don't
   * expect output during the execution.
   */
  console(msg?: string | Error, level = 'info', color?: string) {
    if (!msg) {
      return;
    }
    let actualMessage = msg;
    if (msg instanceof Error) {
      const { message } = defaultHandleError(msg);
      actualMessage = message;
    }
    if (!this.shouldWriteToConsole) {
      this[level](actualMessage);
      return;
    }
    if (color) {
      try {
        // @ts-ignore
        actualMessage = chalk.keyword(color)(actualMessage);
      } catch (e) {
        this.silly('a wrong color provided to logger.console method');
      }
    }
    winston.loggers.get('consoleOnly')[level](actualMessage);
  }

  profile(id: string, meta?: LogEntry) {
    this.logger.profile(id, meta);
  }

  async exitAfterFlush(code = 0, commandName: string) {
    await Analytics.sendData();
    let level;
    let msg;
    if (code === 0) {
      level = 'info';
      msg = `[*] the command ${commandName} has been completed successfully`;
    } else {
      level = 'error';
      msg = `[*] the command ${commandName} has been terminated with an error code ${code}`;
    }
    this.logger[level](msg);
    await waitForLogger();
    process.exit(code);
  }

  debugAndAddBreadCrumb(
    category: string,
    message: string,
    data?: Record<string, any>,
    extraData?: Record<string, any>
  ) {
    this.addToLoggerAndToBreadCrumb('debug', category, message, data, extraData);
  }

  warnAndAddBreadCrumb(category: string, message: string, data?: Record<string, any>, extraData?: Record<string, any>) {
    this.addToLoggerAndToBreadCrumb('warn', category, message, data, extraData);
  }

  errorAndAddBreadCrumb(
    category: string,
    message: string,
    data?: Record<string, any>,
    extraData?: Record<string, any>
  ) {
    this.addToLoggerAndToBreadCrumb('error', category, message, data, extraData);
  }

  private addToLoggerAndToBreadCrumb(
    level: string,
    category: string,
    message: string,
    data?: Record<string, any>,
    extraData?: Record<string, any> | null | undefined
  ) {
    if (!category) throw new TypeError('addToLoggerAndToBreadCrumb, category is missing');
    if (!message) throw new TypeError('addToLoggerAndToBreadCrumb, message is missing');
    const messageWithData = data ? format(message, data) : message;
    this.logger[level](`${category}, ${messageWithData}`, extraData);
    addBreadCrumb(category, message, data, extraData);
  }
}

const winstonLogger = winston.createLogger({
  transports: [new winston.transports.File(baseFileTransportOpts)],
  exceptionHandlers: [new winston.transports.File(exceptionsFileTransportOpts)],
  exitOnError: false,
});

const logger = new BitLogger(winstonLogger);

/**
 * Create a logger instance for extension
 * The extension name will be added as label so it will appear in the begining of each log line
 * The logger is cached for each extension so there is no problem to use getLogger few times for the same extension
 * @param {string} extensionName
 */
export const createExtensionLogger = (extensionName: string) => {
  // Getting logger from cache
  const existingLogger = extensionsLoggers.get(extensionName);

  if (existingLogger) {
    return existingLogger;
  }
  const extensionFileTransportOpts = Object.assign({}, baseFileTransportOpts, {
    filename: path.join(GLOBAL_LOGS, 'extensions.log'),
    label: extensionName,
  });
  const extLogger = winston.createLogger({
    transports: [new winston.transports.File(extensionFileTransportOpts)],
    exceptionHandlers: [new winston.transports.File(extensionFileTransportOpts)],
    exitOnError: false,
  });
  extensionsLoggers.set(extensionName, extLogger);
  return extLogger;
};

export const printWarning = (msg: string) => {
  const cfgNoWarnings = getSync(CFG_NO_WARNINGS);
  if (cfgNoWarnings !== 'true') {
    // eslint-disable-next-line no-console
    console.log(chalk.yellow(`Warning: ${msg}`));
  }
};

/**
 * @credit dpraul from https://github.com/winstonjs/winston/issues/1250
 * it solves an issue when exiting the code explicitly and the log file is not written
 *
 * there are still two issues though.
 * 1. sometimes, an error is thrown "write after end". can be reproduced by running the
 * performance e2e-test on 3,000 components, 100 dependencies, on export.
 * 2. sometimes, it doesn't write all messages to the log. can be reproduced by the same method as
 * above, but even with 300 components and 10 dependencies.
 *
 * if you try to fix these issues, please make sure that after your fix, the following are working:
 * 1. the two cases should work.
 * 2. when error is thrown, it exists successfully with the correct error-code. (the standard
 * e2e-tests cover this multiple times).
 * 3. the ssh is working. (not covered by the e2e-tests). run a simple export to an ssh and make
 * sure it doesn't hang.
 *
 * for the record, the following was working for #1 and #2 but not for #3.
 * ```
 * const loggerDone = new Promise(resolve => logger.logger.on(code ? 'finish' : 'close', resolve));
 * if (code) logger.logger.end();
 * ```
 */
async function waitForLogger() {
  const loggerDone = new Promise((resolve) => logger.logger.on('finish', resolve));
  logger.logger.end();
  return loggerDone;
}

function addBreadCrumb(category: string, message: string, data: Record<string, any> = {}, extraData) {
  const hashedData = {};
  Object.keys(data).forEach((key) => (hashedData[key] = Analytics.hashData(data[key])));
  const messageWithHashedData = format(message, hashedData);
  extraData = extraData instanceof Error ? serializeError(extraData) : extraData;
  Analytics.addBreadCrumb(category, messageWithHashedData, extraData);
}

/**
 * prefix BIT_LOG to the command, provides the ability to log into the console.
 * two options are available here:
 * 1) use the level. e.g. `BIT_LOG=error bit import`.
 * 2) use the message prefix, e.g. `BIT_LOG=ssh bit import`.
 * 3) use multiple message prefixes, e.g. `BIT_LOG=ssh,env bit import`.
 */
if (process.env.BIT_LOG) {
  writeLogToScreen(process.env.BIT_LOG);
}

export function writeLogToScreen(levelOrPrefix = '') {
  const levels = ['error', 'warn', 'info', 'verbose', 'debug', 'silly'];
  const isLevel = levels.includes(levelOrPrefix);
  const prefixes = levelOrPrefix.split(',');
  const filterPrefix = winston.format((info) => {
    if (isLevel) return info;
    if (prefixes.some((prefix) => info.message.startsWith(prefix))) return info;
    return false;
  });
  logger.logger.add(
    new winston.transports.Console({
      level: isLevel ? levelOrPrefix : 'info',
      format: winston.format.combine(
        filterPrefix(),
        winston.format.metadata(),
        winston.format.errors({ stack: true }),
        winston.format.printf((info) => `${info.message} ${getMetadata(info)}`)
      ),
    })
  );
}

/**
 * useful when in the middle of the process, Bit needs to print to the console.
 * it's better than using `console.log` because, this way, it's possible to turn it on/off
 */
winston.loggers.add('consoleOnly', {
  format: winston.format.combine(winston.format.printf((info) => info.message)),
  transports: [new winston.transports.Console({ level: 'silly' })],
});

export default logger;
