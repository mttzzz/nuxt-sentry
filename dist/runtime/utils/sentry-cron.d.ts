export interface CronMonitorOptions {
    checkinMargin?: number;
    maxRuntime?: number;
    timezone?: string;
}
export declare function withCronMonitor<T>(slug: string, schedule: string, fn: () => Promise<T>, options?: CronMonitorOptions): Promise<T>;
