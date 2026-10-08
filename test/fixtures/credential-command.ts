/** Exercises private pipes without opening an OS credential store. */
const mode = process.argv[2];
if (mode === 'hang') setInterval(() => {}, 1000);
else if (mode === 'overflow') process.stdout.write('x'.repeat(65537));
else if (mode === 'invalid-utf8') process.stdout.write(Buffer.from([0xff]));
else if (mode === 'unread-input') process.stdout.write('exited without reading stdin');
else {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  process.stdout.write(JSON.stringify({ args: process.argv.slice(2), stdin: Buffer.concat(chunks).toString('utf8'), tty: Boolean(process.stdin.isTTY), environment: process.env.CREDENTIAL_FIXTURE_SECRET ?? null }));
}
