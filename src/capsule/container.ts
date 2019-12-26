import fs from 'fs-extra';
import _ from 'lodash';
import hash from 'object-hash';
import * as path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { Container, ExecOptions, Exec, ContainerStatus, Volume } from 'capsule';
import { ContainerFactoryOptions } from 'capsule/dist/capsule/container/container-factory';

const debug = require('debug')('fs-container');

export interface BitExecOption extends ExecOptions {
  cwd: string;
}
export interface BitContainerConfig extends ContainerFactoryOptions {
  other?: string;
}

export default class FsContainer implements Container<Exec, Volume> {
  fs: Volume = new Volume();

  id = 'FS Container';
  path: string;
  config: any;
  constructor(config?: BitContainerConfig) {
    this.config = config;
    this.path = _.get(config, 'wrkDir');
    if (!this.path) this.path = this.generateDefaultTmpDir();
  }

  public getPath() {
    return this.path;
  }

  private composePath(pathToCompose) {
    return path.join(this.getPath(), pathToCompose);
  }

  private generateDefaultTmpDir() {
    return path.join(os.tmpdir(), `${this.config.bitId.toString()}_${hash(this.config)}`);
    // return path.join(os.tmpdir(), v4());
  }

  outputFile(file, data, options) {
    const filePath = this.composePath(file);
    debug(`writing file on ${filePath}`);
    return fs.outputFile(filePath, data, options);
  }

  removePath(dir: string): Promise<any> {
    const pathToRemove = this.composePath(dir);
    return fs.remove(pathToRemove);
  }

  async symlink(src: string, dest: string): Promise<any> {
    const srcPath = this.composePath(src);
    const destPath = this.composePath(dest);
    await fs.ensureDir(path.dirname(destPath));
    return fs.ensureSymlink(srcPath, destPath);
  }

  async exec(execOptions: BitExecOption): Promise<Exec> {
    const cwd = execOptions.cwd ? this.composePath(execOptions.cwd) : this.getPath();
    debug(`executing the following command: ${execOptions.command.join(' ')}, on cwd: ${cwd}`);
    // first item in the array is the command itself, other items are the flags
    // `shell: true` is a must for Windows. otherwise, it throws an error  Error: spawn {command} ENOENT
    // @ts-ignore
    const childProcess = spawn(execOptions.command.shift(), execOptions.command, { cwd, shell: true });
    childProcess.abort = async () => childProcess.kill();
    childProcess.inspect = async () => ({
      pid: childProcess.pid,
      running: !childProcess.killed
    });
    return childProcess;
  }

  start(): Promise<void> {
    return fs.ensureDir(this.path);
  }
  // @ts-ignore
  async inspect(): Promise<ContainerStatus> {
    // todo: probably not needed for this container
  }
  async pause(): Promise<void> {
    // do nothing
  }
  async resume(): Promise<void> {
    // do nothing
  }
  // eslint-disable-next-line
  stop(ttl?: number | undefined): Promise<void> {
    return fs.remove(this.path);
  }
  async destroy(): Promise<void> {
    await this.stop();
  }
  log(): Promise<Exec> {
    throw new Error('Method not implemented.');
  }
  on(event: string, fn: (data: any) => void): void {
    return fn(event);
    // throw new Error('Method not implemented.');
  }
}