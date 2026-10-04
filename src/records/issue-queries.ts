// Binds the generated read catalog; storage adapters own transaction boundaries.
import { queries } from 'solarsql';
import { generated, statements } from "./solarsql.generated.ts";

export const issueQueries = queries(generated, statements);
