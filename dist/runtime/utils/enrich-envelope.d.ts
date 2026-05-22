interface AuthUserPayload {
    id?: string | null;
    email?: string | null;
    username?: string | null;
}
export interface EnvelopeEnrichment {
    ip: string;
    user: AuthUserPayload;
}
export declare function enrichEnvelope(envelope: Buffer, injection: EnvelopeEnrichment): Buffer;
export {};
