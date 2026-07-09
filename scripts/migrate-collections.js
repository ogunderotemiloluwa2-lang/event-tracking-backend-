/**
 * Migration Script — MongoDB Collection Cleanup
 *
 * What this script does:
 * 1. Copies attendee-role docs from old `users` → `attendee` collection
 * 2. Copies organizer-role docs from old `users` → `organizers` (if missing)
 * 3. Copies events from old `event crated` / `event created` → `events`
 * 4. Drops the old collections: users, event crated, event created, atendee (typo)
 *
 * Run:  node scripts/migrate-collections.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

async function migrate() {
  if (!process.env.MONGODB_URI) {
    console.error('❌ MONGODB_URI not set in .env');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  console.log('✅ Connected to MongoDB\n');

  // ─── List all collections ──────────────────────────────────────
  const collections = (await db.listCollections().toArray()).map(c => c.name);
  console.log('📋 Existing collections:', collections.join(', '), '\n');

  // ─── 1. Migrate users → organizers / attendee ──────────────────
  if (collections.includes('users')) {
    console.log('━━━ Migrating users collection ━━━');

    const users = db.collection('users');
    const organizers = db.collection('organizers');
    const attendee = db.collection('attendee');

    const allUsers = await users.find({}).toArray();
    console.log(`   Found ${allUsers.length} users total`);

    for (const user of allUsers) {
      if (user.role === 'organizer') {
        // Check if already migrated
        const exists = await organizers.findOne({ email: user.email });
        if (!exists) {
          // Remove _id so MongoDB assigns a new one, or keep it
          await organizers.insertOne({ ...user });
          console.log(`   → Copied organizer: ${user.name} (${user.email})`);
        } else {
          console.log(`   → Skipped (already exists): ${user.name}`);
        }
      } else {
        // Attendee role (or any other role)
        const exists = await attendee.findOne({ email: user.email });
        if (!exists) {
          // Strip organizer-only fields for cleanliness
          const { googleAccessToken, googleRefreshToken, googleDriveFolderId, organization, ...rest } = user;
          await attendee.insertOne({ ...rest });
          console.log(`   → Copied attendee: ${user.name} (${user.email})`);
        } else {
          console.log(`   → Skipped (already exists): ${user.name}`);
        }
      }
    }

    console.log('');
  } else {
    console.log('⚠️  No old `users` collection found — skipping user migration\n');
  }

  // ─── 2. Migrate event crated / event created → events ──────────
  const oldEventCollNames = ['event crated', 'event created', 'events created'];
  for (const oldName of oldEventCollNames) {
    if (collections.includes(oldName)) {
      console.log(`━━━ Migrating ${oldName} → events ━━━`);

      const oldColl = db.collection(oldName);
      const events = db.collection('events');

      const oldEvents = await oldColl.find({}).toArray();
      console.log(`   Found ${oldEvents.length} events in "${oldName}"`);

      for (const evt of oldEvents) {
        // Check by passId or title+date to avoid duplicate
        const exists = evt.passId
          ? await events.findOne({ passId: evt.passId })
          : await events.findOne({ title: evt.title, date: evt.date });

        if (!exists) {
          await events.insertOne({ ...evt });
          console.log(`   → Copied event: ${evt.title}`);
        } else {
          console.log(`   → Skipped (already exists): ${evt.title}`);
        }
      }

      console.log('');
    }
  }

  // ─── 3. Drop old collections ──────────────────────────────────
  const toDrop = ['users', 'events created', 'event crated', 'event created', 'atendee'];
  for (const name of toDrop) {
    if (collections.includes(name)) {
      await db.dropCollection(name);
      console.log(`🗑️  Dropped old collection: "${name}"`);
    }
  }

  console.log('\n━━━ Migration complete ━━━');
  console.log('\nYour collections should now be:');
  console.log('   organizers  → Organizer accounts');
  console.log('   attendee    → Attendee login accounts');
  console.log('   attendees   → RSVP registration data');
  console.log('   events      → Events');
  console.log('   photos      → Photo metadata (if used)\n');

  await mongoose.disconnect();
  process.exit(0);
}

migrate().catch(err => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
