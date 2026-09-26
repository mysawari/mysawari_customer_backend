/**
 * One-time backfill for the Customer -> Membership collection split.
 *
 * `Customer.membership` (an embedded subdocument) is no longer part of the Customer schema — new
 * code reads/writes the separate `memberships` collection instead (see models/membership.model.js).
 * This script copies any existing embedded membership data into that collection, then removes the
 * now-unused field from customer documents. It touches ONLY the `customers` and `memberships`
 * collections; nothing else in the database is read or written.
 *
 * Safe by default: run with no flags and it only reports what it *would* do (zero writes).
 * Pass --apply to actually perform the backfill + cleanup.
 *
 *   node src/database/migrations/20260922-extract-membership-collection.js            # dry run
 *   node src/database/migrations/20260922-extract-membership-collection.js --apply    # writes
 */
require('dotenv').config();
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');

async function run() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    console.error('MONGO_URI is missing in .env — aborting.');
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  const db = mongoose.connection.db;
  const customers = db.collection('customers');
  const memberships = db.collection('memberships');

  console.log(`================================`);
  console.log(`Mode: ${APPLY ? 'APPLY (will write)' : 'DRY RUN (read-only, no writes)'}`);
  console.log(`================================`);

  // Any customer doc that still has the embedded field, whether or not a plan was ever set
  // (the old schema default was an empty placeholder subdocument on every customer).
  const withField = await customers.find({ membership: { $exists: true } }).toArray();
  const withPlan = withField.filter(c => c.membership && c.membership.plan);

  console.log(`Customers with an embedded 'membership' field: ${withField.length}`);
  console.log(`  ...of which have an actual plan set: ${withPlan.length}`);

  let created = 0;
  let skippedExisting = 0;

  for (const c of withPlan) {
    const existing = await memberships.findOne({ customerId: c._id });
    if (existing) {
      skippedExisting++;
      continue;
    }
    const doc = {
      customerId: c._id,
      plan: c.membership.plan,
      activatedAt: c.membership.activatedAt || c.createdAt || new Date(),
      expiresAt: c.membership.expiresAt,
      totalSaved: c.membership.totalSaved || 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    console.log(`${APPLY ? 'Creating' : '[dry-run] Would create'} membership for customer ${c._id}: plan=${doc.plan}, expiresAt=${doc.expiresAt?.toISOString?.() || doc.expiresAt}`);
    if (APPLY) {
      await memberships.insertOne(doc);
    }
    created++;
  }

  console.log(`--------------------------------`);
  console.log(`${APPLY ? 'Created' : 'Would create'}: ${created} membership document(s).`);
  console.log(`Already had a membership document (left untouched): ${skippedExisting}.`);

  if (withField.length > 0) {
    console.log(`${APPLY ? 'Removing' : '[dry-run] Would remove'} the deprecated 'membership' field from ${withField.length} customer document(s) (no other customer fields touched).`);
    if (APPLY) {
      const result = await customers.updateMany(
        { membership: { $exists: true } },
        { $unset: { membership: '' } }
      );
      console.log(`Customer documents updated: ${result.modifiedCount}.`);
    }
  } else {
    console.log(`No customer documents have the deprecated field — nothing to clean up.`);
  }

  console.log(`================================`);
  console.log(APPLY ? 'Done.' : 'Dry run complete — no data was changed. Re-run with --apply to write.');

  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error('Migration failed:', err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
