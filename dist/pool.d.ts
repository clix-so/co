import type { CoConfig, PoolStats, TaskOptions } from "./types.ts";
export declare class WorkerPool {
    private config;
    private workers;
    private pendingQueue;
    private inflightTasks;
    private isShuttingDown;
    private idleTimers;
    constructor(initialConfig?: Partial<CoConfig>);
    stats(): PoolStats;
    configure(options: Partial<CoConfig>): void;
    submit<T>(id: string, fnSource: string, args: unknown[], options: TaskOptions): Promise<T>;
    cancelTask(id: string, error?: Error): void;
    shutdown(options?: {
        force?: boolean;
    }): Promise<void>;
    private dispatchOrQueue;
    private dispatchToWorker;
    private createWorker;
    private handleWorkerMessage;
    private handleWorkerError;
    private markWorkerIdle;
    private terminateIdleWorker;
    private processQueue;
}
//# sourceMappingURL=pool.d.ts.map