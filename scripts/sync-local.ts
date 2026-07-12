// Run one sync pass locally against the vars in .env.local.
//
//   npm run dev:sync            # live: creates/updates Google tasks + writes Redis
//   npm run dev:sync -- --dry   # dry run: fetches + reports, no writes
//
import { runSync } from "../lib/sync";

const dryRun = process.argv.includes("--dry") || process.argv.includes("--dry-run");

runSync({ dryRun })
  .then((summary) => {
    console.log(`\n${dryRun ? "DRY RUN — no changes made" : "Sync applied"}`);
    console.log(
      `fetched: ${summary.fetched.linear} Linear + ${summary.fetched.attio} Attio`,
    );
    const { plan, ...counts } = summary.result;
    console.log("counts:", JSON.stringify(counts));
    if (plan?.length) {
      console.log(`\nPlanned actions (${plan.length}):`);
      for (const p of plan) console.log(`  ${p.action.padEnd(9)} [${p.list}] ${p.title}`);
    }
    process.exit(0);
  })
  .catch((err) => {
    console.error("\nSync failed:\n", err);
    process.exit(1);
  });
