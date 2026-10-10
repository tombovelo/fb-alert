#!/usr/bin/env node
/**
 * Seed : crée (ou promeut) un compte ADMIN dans la base PostgreSQL.
 *
 * Usage :
 *   node scripts/seed-admin.js <email> <motDePasse>
 *   npm run seed:admin -- admin@exemple.com MonMotDePasse
 *
 * - Si l'email n'existe pas : création du compte (rôle ADMIN, abonnement ACTIF).
 * - Si l'email existe déjà : promotion en ADMIN + mise à jour du mot de passe.
 */
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const email = (process.argv[2] || '').trim().toLowerCase();
const password = (process.argv[3] || '').trim();

if (!email || !password) {
  console.error('Usage: node scripts/seed-admin.js <email> <motDePasse>');
  process.exit(1);
}
if (password.length < 8) {
  console.error('Le mot de passe doit contenir au moins 8 caractères.');
  process.exit(1);
}

async function main() {
  const prisma = new PrismaClient();
  const passwordHash = await bcrypt.hash(password, 10);

  const user = await prisma.user.upsert({
    where: { email },
    update: { role: 'ADMIN', subscriptionStatus: 'ACTIVE', passwordHash },
    create: {
      email,
      passwordHash,
      role: 'ADMIN',
      subscriptionStatus: 'ACTIVE',
    },
  });

  console.log('Compte admin prêt :');
  console.log(`  email   : ${user.email}`);
  console.log(`  rôle    : ${user.role}`);
  console.log(`  apiKey  : ${user.apiKey}`);
  console.log('  (apiKey utilisable dans l’app mobile / header X-API-KEY)');

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
