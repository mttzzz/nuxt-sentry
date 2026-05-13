import type Queue from 'bull';
export declare function instrumentQueueProducer<T>(queue: Queue.Queue<T>): Queue.Queue<T>;
export declare function withSentryConsumer<T, R>(queueName: string, job: Queue.Job<T>, fn: () => Promise<R>): Promise<R>;
