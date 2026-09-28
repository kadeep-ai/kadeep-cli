// @ts-check
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/**
 * @typedef {{ provider: string, ci: boolean, commit?: string, branch?: string, pr?: string, repo?: string, runUrl?: string }} CiContext
 */

/** @param {string | undefined} v */
const clean = (v) => (v && v !== 'false' && v !== 'null' ? v : undefined)

/** @param {string[]} args @param {string} [cwd] */
function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000, encoding: 'utf8' }).trim() || undefined
  } catch {
    return undefined
  }
}

/**
 * The commit a check is for, and where the pipeline ran, from the CI provider's environment. On a GitHub pull
 * request this is the PR head, not the merge commit Actions checks out. Outside CI it falls back to git.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ cwd?: string, git?: boolean }} [opts]
 * @returns {CiContext}
 */
export function ciContext(env = process.env, opts = {}) {
  /** @type {CiContext} */
  let c = { provider: 'local', ci: false }
  if (env.GITHUB_ACTIONS === 'true') {
    let head
    try {
      head = env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'))?.pull_request?.head?.sha : undefined
    } catch {
      head = undefined
    }
    const pr = /^refs\/pull\/(\d+)\//.exec(env.GITHUB_REF ?? '')?.[1]
    c = { provider: 'github', ci: true, commit: head ?? env.GITHUB_SHA, branch: clean(env.GITHUB_HEAD_REF) ?? env.GITHUB_REF_NAME, pr, repo: env.GITHUB_REPOSITORY, runUrl: env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL ?? 'https://github.com'}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : undefined }
  } else if (env.GITLAB_CI) {
    c = { provider: 'gitlab', ci: true, commit: env.CI_COMMIT_SHA, branch: env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME ?? env.CI_COMMIT_REF_NAME, pr: env.CI_MERGE_REQUEST_IID, repo: env.CI_PROJECT_PATH, runUrl: env.CI_JOB_URL ?? env.CI_PIPELINE_URL }
  } else if (env.CIRCLECI) {
    c = { provider: 'circleci', ci: true, commit: env.CIRCLE_SHA1, branch: env.CIRCLE_BRANCH, pr: /\/pull\/(\d+)/.exec(env.CIRCLE_PULL_REQUEST ?? '')?.[1], repo: env.CIRCLE_PROJECT_USERNAME && env.CIRCLE_PROJECT_REPONAME ? `${env.CIRCLE_PROJECT_USERNAME}/${env.CIRCLE_PROJECT_REPONAME}` : undefined, runUrl: env.CIRCLE_BUILD_URL }
  } else if (env.BITBUCKET_BUILD_NUMBER) {
    c = { provider: 'bitbucket', ci: true, commit: env.BITBUCKET_COMMIT, branch: env.BITBUCKET_BRANCH, pr: env.BITBUCKET_PR_ID, repo: env.BITBUCKET_REPO_FULL_NAME, runUrl: env.BITBUCKET_REPO_FULL_NAME ? `https://bitbucket.org/${env.BITBUCKET_REPO_FULL_NAME}/pipelines/results/${env.BITBUCKET_BUILD_NUMBER}` : undefined }
  } else if (env.BUILDKITE) {
    c = { provider: 'buildkite', ci: true, commit: env.BUILDKITE_COMMIT, branch: env.BUILDKITE_BRANCH, pr: clean(env.BUILDKITE_PULL_REQUEST), repo: env.BUILDKITE_REPO, runUrl: env.BUILDKITE_BUILD_URL }
  } else if (env.TF_BUILD) {
    c = { provider: 'azure', ci: true, commit: env.BUILD_SOURCEVERSION, branch: env.SYSTEM_PULLREQUEST_SOURCEBRANCH?.replace(/^refs\/heads\//, '') ?? env.BUILD_SOURCEBRANCHNAME, pr: env.SYSTEM_PULLREQUEST_PULLREQUESTNUMBER ?? env.SYSTEM_PULLREQUEST_PULLREQUESTID, repo: env.BUILD_REPOSITORY_NAME, runUrl: env.SYSTEM_COLLECTIONURI && env.BUILD_BUILDID ? `${env.SYSTEM_COLLECTIONURI}${env.SYSTEM_TEAMPROJECT ?? ''}/_build/results?buildId=${env.BUILD_BUILDID}` : undefined }
  } else if (env.JENKINS_URL) {
    c = { provider: 'jenkins', ci: true, commit: env.GIT_COMMIT, branch: env.CHANGE_BRANCH ?? env.BRANCH_NAME ?? env.GIT_BRANCH, pr: env.CHANGE_ID, runUrl: env.BUILD_URL }
  } else if (env.CI && env.CI !== 'false') {
    c = { provider: 'ci', ci: true }
  }
  if (opts.git !== false) {
    c.commit ??= git(['rev-parse', 'HEAD'], opts.cwd)
    if (!c.branch) {
      const b = git(['rev-parse', '--abbrev-ref', 'HEAD'], opts.cwd)
      c.branch = b && b !== 'HEAD' ? b : undefined
    }
  }
  return /** @type {CiContext} */ (Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined && v !== '')))
}
