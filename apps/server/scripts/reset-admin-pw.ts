import { prisma } from '../src/db.js';
import { hashPassword } from '../src/auth/password.js';

const u = await prisma.user.findUnique({ where: { email: 'admin@local' } });
if (!u) throw new Error('admin@local not found');
await prisma.user.update({
  where: { id: u.id },
  data: { passwordHash: await hashPassword('123456789'), mustChangePassword: false },
});
console.log('password reset ok');
await prisma.$disconnect();
