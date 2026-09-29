// @ts-check
import { EXIT, usage } from '../errors.mjs'
import { jobStatus, progressText } from '../ops/run.mjs'
import { runView } from '../views/run-view.mjs'

/** @typedef {import('../cli.mjs').Command} Command */

/** @type {Command} */
const jobs = {
  name: 'jobs',
  summary: 'Check a queued or running job (from `kadeep run --no-wait`)',
  usage: ['kadeep jobs show <jobId>', 'kadeep jobs show <jobId> --wait [--timeout <minutes>]     # follow it to the verdict'],
  options: { wait: { type: 'boolean' }, timeout: { type: 'string' } },
  async run({ values, positionals, out, client, project, num, signal }) {
    if (positionals[0] !== 'show' || !positionals[1]) throw usage('Usage: kadeep jobs show <jobId> [--wait]')
    const c = client('run')
    const projectId = c.auth.kind === 'ci' ? (await project(c)).id : values.project
    if (!values.wait) {
      const job = /** @type {any} */ (await jobStatus(c, { project: projectId, jobId: positionals[1] }))
      out.result(job, () => out.line(`${job.id}  ${progressText(job)}${job.error ? `  ${out.c.red(job.error)}` : ''}`))
      return EXIT.OK
    }
    const view = runView(out, { title: `job ${positionals[1]}` })
    /** @type {import('../ops/run.mjs').RunTestsResult} */
    let r
    try {
      r = /** @type {import('../ops/run.mjs').RunTestsResult} */ (await jobStatus(c, { project: projectId, jobId: positionals[1], wait: true, timeoutMs: (num('timeout') ?? 30) * 60_000, onProgress: view.progress, signal }))
    } catch (err) {
      view.stop()
      throw err
    }
    view.done(r)
    return r.ok ? EXIT.OK : EXIT.FAILED
  }
}

export default [jobs]
