import yargs from 'yargs/yargs';
import defaultConfig from '../config.json';

type inferredConfigType = typeof defaultConfig;
interface Config extends inferredConfigType {
  logLevelConsole: 'debug' | 'info' | 'error' | 'none' | 'silly';
  logLevelFile: 'debug' | 'info' | 'error' | 'none' | 'silly';
}

const parser = yargs(process.argv.slice(2))
  .parserConfiguration({ 'strip-aliased': true, 'strip-dashed': true })
  .option('assets-url', {
    alias: 'a',
    describe: 'NHK assets url (for JS & thumbnails)',
    type: 'string',
    default: defaultConfig.assetsUrl
  })
  .option('safety-buffer', {
    alias: 'b',
    describe: 'Number of extra milliseconds to record before and after scheduled airtime',
    type: 'number',
    default: defaultConfig.safetyBuffer
  })
  .option('config', {
    alias: 'c',
    describe: 'Location of config file',
    config: true,
    type: 'string'
  })
  .option('crop', {
    alias: 'C',
    describe: [
      'Attempt to automatically detect and crop out breaking news banners',
      '(requires re-encoding) (this uses a lot of CPU & memory)'
    ].join(' '),
    type: 'boolean',
    default: defaultConfig.crop
  })
  .option('save-dir', {
    alias: 'd',
    describe: 'Directory in which to save recorded programmes',
    type: 'string',
    default: defaultConfig.saveDir
  })
  .option('log-file', {
    alias: 'f',
    describe: 'Location of log file',
    type: 'string',
    default: defaultConfig.logFile
  })
  .option('stream-url', {
    alias: 'i',
    describe: 'URL from which to record stream',
    type: 'string',
    default: defaultConfig.streamUrl
  })
  .option('thread-limit', {
    alias: 'j',
    describe: 'Maximum threads to use for video processing',
    type: 'number',
    default: defaultConfig.threadLimit
  })
  .option('log-level-console', {
    alias: 'k',
    describe: 'Logging level to output to console',
    choices: ['debug', 'info', 'error', 'none', 'silly'],
    type: 'string',
    default: defaultConfig.logLevelConsole
  })
  .option('keep-original', {
    alias: ['K', 'keep-untrimmed'],
    describe: 'If any post-processing options are enabled, also keep the original copy',
    type: 'boolean',
    default: defaultConfig.keepOriginal
  })
  .option('log-level-file', {
    alias: 'l',
    describe: 'Logging level to output to log file',
    choices: ['debug', 'info', 'error', 'none', 'silly'],
    type: 'string',
    default: defaultConfig.logLevelFile
  })
  .option('match-pattern', {
    alias: 'm',
    describe: 'Glob pattern of desired program name (can be used multiple times)',
    type: 'string',
    array: true,
    default: defaultConfig.matchPattern
  })
  .option('time-offset', {
    alias: 'o',
    describe: 'Time offset relative to system time in milliseconds (e.g. to handle stream delays)',
    type: 'number',
    default: defaultConfig.timeOffset
  })
  .option('schedule-url', {
    alias: 's',
    describe: 'NHK schedule API base URL',
    type: 'string',
    default: defaultConfig.scheduleUrl
  })
  .option('minimum-duration', {
    alias: 't',
    describe: 'Minimum programme run time to record in milliseconds',
    type: 'number',
    default: defaultConfig.minimumDuration
  })
  .option('trim', {
    alias: 'T',
    describe: 'Attempt to automatically trim video',
    type: 'boolean',
    default: defaultConfig.trim
  });

const parsedArgs = parser.parseSync();
const { _: _positional, $0: _command, config: _configPath, ...resolvedConfig } = parsedArgs;

//TODO: validate config
export default resolvedConfig as Config;
