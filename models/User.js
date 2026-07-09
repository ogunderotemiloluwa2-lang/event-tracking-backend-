// User.js — compatibility layer.
// The codebase has been split into two separate models:
//   Organizer    → stores in the 'organizers' collection
//   AttendeeUser → stores in the 'attendee' collection
//
// This file re-exports both for backwards compatibility and provides
// a helper to find a user by ID from either collection.

const Organizer = require('./Organizer');
const AttendeeUser = require('./AttendeeUser');

/**
 * Find a user by ID from either the organizers or attendee collection.
 * This is useful when you don't know which role a user has but have their ID.
 */
async function findUserById(id) {
  let user = await Organizer.findById(id);
  if (user) return user;
  user = await AttendeeUser.findById(id);
  return user;
}

/**
 * Find a user by email (case-insensitive) from either collection.
 */
async function findUserByEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`^${escaped}$`, 'i');

  let user = await Organizer.findOne({ email: regex });
  if (user) return user;
  user = await AttendeeUser.findOne({ email: regex });
  return user;
}

module.exports = {
  Organizer,
  AttendeeUser,
  findUserById,
  findUserByEmail,
};
