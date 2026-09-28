// @ts-check
/**
 * kadeep as a library: the pieces releasegate (and your own scripts) build on. Everything talks to the KaDeep API
 * over HTTP; nothing here needs the KaDeep server code.
 */
export { VERSION, EXIT, KadeepError } from './errors.mjs'
export { DEFAULT_API, loadConfig, resolveApi, configPath } from './config.mjs'
export { createClient, resolveAuth } from './client.mjs'
export { routes, resolveProject } from './api.mjs'
export { runTests, jobStatus, BROWSERS, VIEWPORTS, DEFAULT_RUN_TIMEOUT_MS } from './ops/run.mjs'
export { locPush, locPull, locStatus, locValidate } from './ops/loc.mjs'
export { listProjects, listSuites, listTests, getTest, listRuns, getRun, listSuiteRuns, getSuiteRun, listIssues } from './ops/browse.mjs'
export { ciContext } from './ci-env.mjs'
export { junitXml } from './junit.mjs'
export { duration } from './output.mjs'
export { USER_AGENT } from './http.mjs'

/**
 * @typedef {import('./ci-env.mjs').CiContext} CiContext
 * @typedef {import('./client.mjs').Client} Client
 * @typedef {import('./client.mjs').Auth} Auth
 * @typedef {import('./ops/run.mjs').RunTestsResult} RunTestsResult
 */
