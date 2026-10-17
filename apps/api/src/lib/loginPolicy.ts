/**
 * Who may sign in: official email domains (sub-domains included, e.g. mum.tisa.in under tisa.in),
 * plus individual non-official addresses (e.g. Gmail) that the Super Admin has added on purpose.
 */
import { getCompany } from '../services/company';

export const domainOf = (email: string) => email.toLowerCase().trim().split('@').pop() ?? '';
export const isOfficialEmail = (email: string, domains: readonly string[]) => {
  const d = domainOf(email);
  return domains.some((x) => { const dom = x.toLowerCase().trim().replace(/^@/, ''); return !!dom && (d === dom || d.endsWith(`.${dom}`)); });
};
export async function loginDomains(): Promise<string[]> {
  const c = await getCompany();
  return c.loginDomains?.length ? c.loginDomains : ['tisa.in'];
}
export async function mayUseEmail(email: string, externalAllowed: boolean) {
  return externalAllowed || isOfficialEmail(email, await loginDomains());
}
export const isSuperAdminPerms = (perms: readonly string[]) => perms.includes('*');
