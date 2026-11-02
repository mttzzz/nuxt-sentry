export const DATA_COLLECTION = {
  userInfo: true,
  cookies: true,
  httpHeaders: { request: true, response: true },
  httpBodies: [],
  urlQueryParams: true,
  graphQL: { document: true, variables: true },
  genAI: { inputs: true, outputs: true },
  mcp: { inputs: false, outputs: false },
  databaseQueryData: true,
  queues: false,
  stackFrameVariables: true,
  frameContextLines: 7
};
