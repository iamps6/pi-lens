interface User { id: number; name: string; }

async function greet(users: User[]): Promise<void> {
  for (const u of users) {
    // greet each user
    console.log(`Hello, ${u.name} (#${u.id})`);
  }
}

greet([{ id: 1, name: "Ada" }, { id: 2, name: "Linus" }]);
