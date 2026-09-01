#!/usr/bin/env node
import { main } from './cli.js'

try {
  process.exitCode = await main()
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
