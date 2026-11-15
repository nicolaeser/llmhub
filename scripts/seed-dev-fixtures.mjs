export async function insertDevelopmentFixtures(client) {
  await client.$transaction(async (tx) => {
    const company = await tx.organization.create({
      data: { alias: "Example Company", maxBudget: "1000", budgetDuration: "1mo", labelKeys: ["environment", "workload"] },
    });
    for (const alias of ["Engineering", "Operations"]) {
      const department = await tx.team.create({
        data: { alias, orgId: company.id, maxBudget: "400", budgetDuration: "1mo" },
      });
      await tx.project.create({
        data: { alias: `${alias} Sandbox`, orgId: company.id, teamId: department.id, maxBudget: "200", budgetDuration: "1mo" },
      });
      await tx.member.create({
        data: { name: `${alias} Example Person`, email: `${alias.toLowerCase()}@example.test`, orgId: company.id, teamId: department.id, maxBudget: "100", budgetDuration: "1mo" },
      });
    }
  });
}
