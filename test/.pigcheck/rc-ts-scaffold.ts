// Scratch: the TypeScript reference scaffold for the json-from pig check.
const { recipeScaffold } = await import("../../recipes/index.ts");
const { loadRecipes } = await import("../../recipes/config.ts");
const t = loadRecipes(undefined).recipes.work;
process.stdout.write(recipeScaffold("svc", { description: "Recipe for json-from", model: "fixture/m1", thinkingLevel: "off" }, structuredClone(t.config)));
