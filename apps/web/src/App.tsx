import { Navigate, Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
import { Spinner } from './components/ui';
import { useAuth } from './lib/auth';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import { AmcPage, ClientDetail, ClientsPage, InventoryPage, LeadsPage, SitesPage, UsersPage, VendorsPage } from './pages/Masters';
import { ChallanDetail, ChallansPage, NewChallan, OrderDetail, OrderEditor, OrdersPage, QuotationDetail, QuotationEditor, QuotationsPage } from './pages/Sales';
import { GrnDetail, GrnsPage, PoDetail, PoEditor, PurchaseOrdersPage } from './pages/Purchase';
import { InvoiceDetail, InvoiceEditor, InvoicesPage, ReceivablesPage } from './pages/Billing';
import { NewTicket, ServiceReportDetail, ServiceReportsPage, SitePhotosPage, TicketDetail, TicketsPage } from './pages/Service';
import { AttendancePage, ExpenseDetail, ExpenseEditor, ExpensesPage, RequisitionDetail, RequisitionsPage } from './pages/Field';
import { RolesPage, SettingsPage } from './pages/Admin';

export default function App() {
  const { user, loading } = useAuth();
  if (loading) return <Spinner className="h-full items-center" />;
  if (!user) return <Login />;
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="leads" element={<LeadsPage />} />
        <Route path="clients" element={<ClientsPage />} />
        <Route path="clients/:id" element={<ClientDetail />} />
        <Route path="sites" element={<SitesPage />} />
        <Route path="sites/:id" element={<SitesPage />} />
        <Route path="quotations" element={<QuotationsPage />} />
        <Route path="quotations/new" element={<QuotationEditor />} />
        <Route path="quotations/:id" element={<QuotationDetail />} />
        <Route path="quotations/:id/edit" element={<QuotationEditor />} />
        <Route path="orders" element={<OrdersPage />} />
        <Route path="orders/new" element={<OrderEditor />} />
        <Route path="orders/:id" element={<OrderDetail />} />
        <Route path="challans" element={<ChallansPage />} />
        <Route path="challans/new" element={<NewChallan />} />
        <Route path="challans/:id" element={<ChallanDetail />} />
        <Route path="invoices" element={<InvoicesPage />} />
        <Route path="invoices/new" element={<InvoiceEditor />} />
        <Route path="invoices/:id" element={<InvoiceDetail />} />
        <Route path="receivables" element={<ReceivablesPage />} />
        <Route path="purchase-orders" element={<PurchaseOrdersPage />} />
        <Route path="purchase-orders/new" element={<PoEditor />} />
        <Route path="purchase-orders/:id" element={<PoDetail />} />
        <Route path="purchase-orders/:id/edit" element={<PoEditor />} />
        <Route path="grns" element={<GrnsPage />} />
        <Route path="grns/:id" element={<GrnDetail />} />
        <Route path="inventory" element={<InventoryPage />} />
        <Route path="vendors" element={<VendorsPage />} />
        <Route path="tickets" element={<TicketsPage />} />
        <Route path="tickets/new" element={<NewTicket />} />
        <Route path="tickets/:id" element={<TicketDetail />} />
        <Route path="service-reports" element={<ServiceReportsPage />} />
        <Route path="service-reports/:id" element={<ServiceReportDetail />} />
        <Route path="amc" element={<AmcPage />} />
        <Route path="site-photos" element={<SitePhotosPage />} />
        <Route path="attendance" element={<AttendancePage />} />
        <Route path="requisitions" element={<RequisitionsPage />} />
        <Route path="requisitions/:id" element={<RequisitionDetail />} />
        <Route path="expenses" element={<ExpensesPage />} />
        <Route path="expenses/new" element={<ExpenseEditor />} />
        <Route path="expenses/:id" element={<ExpenseDetail />} />
        <Route path="expenses/:id/edit" element={<ExpenseEditor />} />
        <Route path="users" element={<UsersPage />} />
        <Route path="roles" element={<RolesPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
