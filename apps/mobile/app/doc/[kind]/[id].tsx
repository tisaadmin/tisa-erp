import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { ApprovalCard } from '../../../src/components/Approve';
import { Badge, Btn, C, Card, Chips, Empty, Field, Input, Screen, s, useFetch, useRun } from '../../../src/components/ui';
import { api } from '../../../src/lib/api';
import { useAuth } from '../../../src/lib/auth';
import { fmtDate, inr, label, todayIso } from '../../../src/lib/format';
import type { Inbox } from '../../../src/lib/manage';

const PATH: Record<string, string> = { order: '/orders', quote: '/quotations', po: '/purchase-orders', invoice: '/invoices', grn: '/grns', challan: '/challans', vendorbill: '/vendor-bills' };
const NAME: Record<string, string> = { order: 'Order', quote: 'Quotation', po: 'Purchase order', invoice: 'Invoice', grn: 'Goods receipt', challan: 'Challan', vendorbill: 'Vendor bill' };
const ENTITY: Record<string, string> = { order: 'ORDER', quote: 'QUOTATION', po: 'PURCHASE_ORDER', invoice: 'INVOICE', challan: 'CHALLAN' };
const MODES = ['NEFT', 'RTGS', 'IMPS', 'UPI', 'CHEQUE', 'CASH'];

/** Money received (invoice) or paid (vendor bill) against a document. */
function PayForm({ title, path, balance, onDone }: { title: string; path: string; balance: number; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [p, setP] = useState({ amount: String(Math.round(balance * 100) / 100), tdsAmount: '0', mode: 'NEFT', reference: '', date: todayIso() });
  const { busy, run } = useRun();
  if (!open) return <Btn icon="cash" title={title} onPress={() => setOpen(true)} />;
  return (
    <Card title={title}>
      <Field label="Amount (₹)"><Input keyboardType="numeric" value={p.amount} onChangeText={(amount) => setP({ ...p, amount })} /></Field>
      <Field label="TDS deducted (₹)"><Input keyboardType="numeric" value={p.tdsAmount} onChangeText={(tdsAmount) => setP({ ...p, tdsAmount })} /></Field>
      <Field label="Mode"><Chips options={MODES} value={p.mode} onChange={(mode) => setP({ ...p, mode })} /></Field>
      <Field label="UTR / cheque no."><Input value={p.reference} onChangeText={(reference) => setP({ ...p, reference })} /></Field>
      <Field label="Date (YYYY-MM-DD)"><Input value={p.date} onChangeText={(date) => setP({ ...p, date })} /></Field>
      <Text style={s.muted}>Balance {inr(balance)}. Amount + TDS settles it.</Text>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Btn style={{ flex: 1 }} variant="secondary" title="Cancel" onPress={() => setOpen(false)} />
        <Btn style={{ flex: 1 }} variant="success" title="Save" busy={busy} disabled={!(Number(p.amount) > 0)} onPress={() => run(async () => {
          await api(path, { body: { amount: Number(p.amount), tdsAmount: Number(p.tdsAmount) || 0, mode: p.mode, reference: p.reference || null, date: p.date } });
          setOpen(false); onDone();
        }, 'Payment recorded')} />
      </View>
    </Card>
  );
}

/** Quick status steps by department: quote sent / won / lost, PO sent to the vendor. */
function StatusSteps({ kind, x, onDone }: { kind: string; x: any; onDone: () => void }) {
  const { can } = useAuth();
  const { busy, run } = useRun();
  const steps: [string, string, string, any][] = [];
  if (kind === 'quote' && can('quotations:edit')) {
    if (['DRAFT', 'APPROVED'].includes(x.status)) steps.push(['Mark sent to client', `/quotations/${x.id}/status`, 'SENT', 'primary']);
    if (x.status === 'SENT') { steps.push(['Client accepted', `/quotations/${x.id}/status`, 'ACCEPTED', 'success']); steps.push(['Lost', `/quotations/${x.id}/status`, 'REJECTED', 'secondary']); }
  }
  if (kind === 'po' && can('purchase_orders:edit') && x.status === 'APPROVED') steps.push(['Mark sent to vendor', `/purchase-orders/${x.id}/send`, '', 'primary']);
  if (!steps.length) return null;
  return (
    <View style={{ flexDirection: 'row', gap: 8 }}>
      {steps.map(([t, path, status, v]) => <Btn key={t} style={{ flex: 1 }} variant={v} title={t} busy={busy} onPress={() => run(async () => { await api(path, { body: status ? { status } : {} }); onDone(); })} />)}
    </View>
  );
}

function KV({ rows }: { rows: [string, string | number | null | undefined][] }) {
  return (
    <View style={{ gap: 6 }}>
      {rows.filter(([, v]) => v != null && v !== '').map(([k, v]) => (
        <View key={k} style={{ flexDirection: 'row', gap: 10 }}><Text style={[s.muted, { width: 110 }]}>{k}</Text><Text style={{ flex: 1, color: C.text, fontSize: 14 }}>{String(v)}</Text></View>
      ))}
    </View>
  );
}

/** Any document on the phone: header, lines, totals — and approve / send back when it is waiting for you. */
export default function Doc() {
  const { kind, id } = useLocalSearchParams<{ kind: string; id: string }>();
  const { can } = useAuth();
  const d = useFetch<any>(PATH[kind] ? `${PATH[kind]}/${id}` : null);
  const inbox = useFetch<Inbox>('/approvals/inbox');
  const billing = useFetch<{ summary: { orderTaxable: number; billedTaxable: number; balanceTaxable: number; billedPct: number } }>(kind === 'order' ? `/orders/${id}/billing` : null);
  const x = d.data;
  const waiting = inbox.data?.items.find((i) => i.id === id);
  const reload = () => { d.reload(); inbox.reload(); billing.reload(); };
  if (!PATH[kind]) return <Empty text="Unknown document" />;
  const party = x?.client?.name ?? x?.vendor?.name ?? x?.lead?.name;
  const head: [string, any][] = !x ? [] : [
    ['Date', fmtDate(x.date)],
    [kind === 'po' || kind === 'grn' || kind === 'vendorbill' ? 'Vendor' : 'Client', party],
    ["Supplier's bill", x.billNo ? `${x.billNo} · ${fmtDate(x.billDate)}` : null],
    ['Site', x.site?.name ?? x.deliverToSite?.name],
    ['Subject', x.subject],
    ['Order', x.salesOrder?.number ?? x.order?.number],
    ['PO', x.po?.number],
    ['Client PO', x.clientPoNo],
    ['Type', x.type ? label(x.type) : null],
    ['Due', x.dueDate ? fmtDate(x.dueDate) : null],
    ['Vehicle', x.vehicleNo],
    ['Remarks', x.notes],
  ];
  const lines: any[] = x?.items ?? [];
  return (
    <Screen onRefresh={reload} refreshing={d.loading}>
      <Stack.Screen options={{ title: x?.number ?? NAME[kind] }} />
      {!!d.error && <Empty text={d.error} />}
      {waiting && <ApprovalCard item={waiting} noLink onDone={() => { reload(); router.back(); }} />}
      {x && (
        <>
          <Card title={`${NAME[kind]} ${x.number ?? ''}`} right={<Badge text={x.status} />}>
            <KV rows={head} />
          </Card>
          <StatusSteps kind={kind} x={x} onDone={reload} />
          {ENTITY[kind] && (
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Btn style={{ flex: 1 }} variant="secondary" icon="chatbubbles" title="Discuss" onPress={() => api<{ id: string }>('/chats/record', { body: { entityType: ENTITY[kind], entityId: x.id, title: `${NAME[kind]} ${x.number ?? ''}${party ? ` — ${party}` : ''}` } }).then((c) => router.push(`/chat/${c.id}`)).catch(() => {})} />
              <Btn style={{ flex: 1 }} variant="secondary" icon="checkbox" title="Add task" onPress={() => router.push({ pathname: '/task/new', params: { entityType: ENTITY[kind], entityId: x.id, label: `${NAME[kind]} ${x.number ?? ''}${party ? ` — ${party}` : ''}` } })} />
            </View>
          )}
          {kind === 'invoice' && can('payments:create') && ['ISSUED', 'PARTIALLY_PAID'].includes(x.status) && <PayForm title="Record receipt" path={`/invoices/${x.id}/payments`} balance={Number(x.total) - Number(x.amountPaid ?? 0)} onDone={reload} />}
          {kind === 'vendorbill' && can('vendor_bills:pay') && ['UNPAID', 'PARTIALLY_PAID'].includes(x.status) && <PayForm title="Record payment to vendor" path={`/vendor-bills/${x.id}/payments`} balance={Number(x.total) - Number(x.amountPaid ?? 0)} onDone={reload} />}
          {kind === 'order' && billing.data && (
            <Card title="Billing">
              <View style={{ height: 8, backgroundColor: '#f1f5f9', borderRadius: 4 }}><View style={{ width: `${Math.min(100, billing.data.summary.billedPct)}%`, height: 8, backgroundColor: C.brand, borderRadius: 4 }} /></View>
              <KV rows={[['Billed', `${inr(billing.data.summary.billedTaxable)} (${billing.data.summary.billedPct}%)`], ['Balance', inr(billing.data.summary.balanceTaxable)]]} />
            </Card>
          )}
          {kind === 'quote' && x.costingSummary && (
            <Card title="Costing (internal)">
              <KV rows={[['Material cost', inr(x.costingSummary.material)], ['Total cost', inr(x.costingSummary.totalCost)], ['Gross profit', `${inr(x.costingSummary.grossProfit)} · ${x.costingSummary.gpPct}%`], ['Target', `${x.costingSummary.minGpPct}%`]]} />
            </Card>
          )}
          {lines.length > 0 && (
            <Card title={`Items (${lines.length})`}>
              {lines.map((l, i) => (
                <View key={l.id ?? i} style={{ gap: 2, paddingBottom: 8, borderBottomWidth: i < lines.length - 1 ? 1 : 0, borderBottomColor: '#eef2f7' }}>
                  <Text style={{ fontSize: 14, color: C.text }}>{l.useAltDescription && l.altDescription ? l.altDescription : l.description}</Text>
                  <Text style={s.muted}>
                    {l.qty != null ? `${Number(l.qty)} ${l.unit ?? ''}` : l.acceptedQty != null ? `accepted ${Number(l.acceptedQty)}` : ''}
                    {l.rate != null ? ` × ${inr(l.rate)}` : ''}{l.taxable != null ? ` = ${inr(l.taxable)}` : ''}
                    {l.deliveredQty != null && kind === 'order' ? ` · delivered ${Number(l.deliveredQty)}` : ''}
                    {l.receivedQty != null && kind === 'po' ? ` · received ${Number(l.receivedQty)}` : ''}
                    {l.costRate != null ? ` · cost ${inr(l.costRate)}` : ''}
                    {Number(l.excessQty) > 0 ? ` · +${Number(l.excessQty)} over the order` : ''}
                  </Text>
                </View>
              ))}
            </Card>
          )}
          {x.total != null && (
            <Card title="Totals">
              <KV rows={[['Taxable', inr(x.taxable)], ['CGST', x.cgst ? inr(x.cgst) : null], ['SGST', x.sgst ? inr(x.sgst) : null], ['IGST', x.igst ? inr(x.igst) : null], ['Total', inr(x.total)],
                [kind === 'vendorbill' ? 'Paid' : 'Received', ['invoice', 'vendorbill'].includes(kind) ? inr(x.amountPaid) : null], ['Balance', ['invoice', 'vendorbill'].includes(kind) ? inr(Number(x.total) - Number(x.amountPaid ?? 0)) : null]]} />
            </Card>
          )}
          {!!x.payments?.length && (
            <Card title={kind === 'vendorbill' ? 'Payments made' : 'Receipts'}>
              {x.payments.map((p: any) => <Text key={p.id} style={s.muted}>{fmtDate(p.date)} · {label(p.mode)} {p.reference ?? ''} · {inr(p.amount)}{Number(p.tdsAmount) ? ` + TDS ${inr(p.tdsAmount)}` : ''}</Text>)}
            </Card>
          )}
        </>
      )}
    </Screen>
  );
}
