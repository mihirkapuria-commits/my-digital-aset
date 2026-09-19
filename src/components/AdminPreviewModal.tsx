import React, { useState, useEffect } from 'react';
import { 
  X, 
  Lock, 
  Check, 
  Settings, 
  DollarSign, 
  ShieldAlert, 
  Tv, 
  ListPlus, 
  Users, 
  Layers, 
  Save, 
  KeyRound, 
  Plus, 
  Trash2, 
  CheckCircle2,
  Package
} from 'lucide-react';
import { GlobalSiteSettings, Product, Category } from '../types';
import { futureProducts } from '../data/initialData';

interface AdminPreviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: GlobalSiteSettings;
  onUpdateSettings: (newSettings: GlobalSiteSettings) => void;
  product: Product;
  onUpdateProduct: (newProduct: Product) => void;
  categories: Category[];
  onUpdateCategories: (newCategories: Category[]) => void;
}

export const AdminPreviewModal: React.FC<AdminPreviewModalProps> = ({
  isOpen,
  onClose,
  settings,
  onUpdateSettings,
  product,
  onUpdateProduct,
  categories,
  onUpdateCategories,
}) => {
  const [activeTab, setActiveTab] = useState<'pricing' | 'security' | 'categories' | 'adsense' | 'products' | 'subscribers'>('pricing');
  const [savedNotice, setSavedNotice] = useState(false);

  // Local state for pricing
  const [basePrice, setBasePrice] = useState(product.basePriceInr.toString());
  const [gstRate, setGstRate] = useState(product.gstRatePercent.toString());
  const [trialDays, setTrialDays] = useState(product.trialDays.toString());

  // Local state for payment details
  const [phone, setPhone] = useState(settings.payment.phoneNumber);
  const [beneficiary, setBeneficiary] = useState(settings.payment.beneficiaryName);
  const [gstEmail, setGstEmail] = useState(settings.payment.gstCreditEmail);

  // Local state for AdSense
  const [adSenseEnabled, setAdSenseEnabled] = useState(settings.adsense.isEnabled);
  const [adSensePubId, setAdSensePubId] = useState(settings.adsense.publisherId);
  const [slotInFeed, setSlotInFeed] = useState(settings.adsense.placements.inFeedSeparator);
  const [slotHomepage, setSlotHomepage] = useState(settings.adsense.placements.homepageBanner);
  const [slotFooter, setSlotFooter] = useState(settings.adsense.placements.footerBanner);

  // Local state for IP allowlist
  const [ipAddresses, setIpAddresses] = useState(settings.security.allowedIpAddresses);
  const [newIpInput, setNewIpInput] = useState('');

  // Category new input
  const [newCatName, setNewCatName] = useState('');

  // Sync state when modal is opened
  useEffect(() => {
    if (isOpen) {
      setBasePrice(product.basePriceInr.toString());
      setGstRate(product.gstRatePercent.toString());
      setTrialDays(product.trialDays.toString());
      setPhone(settings.payment.phoneNumber);
      setBeneficiary(settings.payment.beneficiaryName);
      setGstEmail(settings.payment.gstCreditEmail);
      setAdSenseEnabled(settings.adsense.isEnabled);
      setAdSensePubId(settings.adsense.publisherId);
      setSlotInFeed(settings.adsense.placements.inFeedSeparator);
      setSlotHomepage(settings.adsense.placements.homepageBanner);
      setSlotFooter(settings.adsense.placements.footerBanner);
      setIpAddresses(settings.security.allowedIpAddresses);
    }
  }, [isOpen, product, settings]);

  // Close when pressing the Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    if (isOpen) {
      window.addEventListener('keydown', handleKeyDown);
    }
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleSaveAll = () => {
    // 1. Update product pricing
    const updatedProd: Product = {
      ...product,
      basePriceInr: parseFloat(basePrice) || 252,
      gstRatePercent: parseFloat(gstRate) || 18,
      trialDays: parseInt(trialDays, 10) || 3,
    };
    onUpdateProduct(updatedProd);

    // 2. Update settings
    const updatedSettings: GlobalSiteSettings = {
      ...settings,
      payment: {
        ...settings.payment,
        phoneNumber: phone,
        beneficiaryName: beneficiary,
        gstCreditEmail: gstEmail,
      },
      adsense: {
        ...settings.adsense,
        isEnabled: adSenseEnabled,
        publisherId: adSensePubId,
        placements: {
          homepageBanner: slotHomepage,
          inFeedSeparator: slotInFeed,
          footerBanner: slotFooter,
        },
      },
      security: {
        ...settings.security,
        allowedIpAddresses: ipAddresses,
      },
    };
    onUpdateSettings(updatedSettings);

    setSavedNotice(true);
    setTimeout(() => setSavedNotice(false), 2500);
  };

  const handleAddIp = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newIpInput.trim() || ipAddresses.includes(newIpInput.trim())) return;
    setIpAddresses([...ipAddresses, newIpInput.trim()]);
    setNewIpInput('');
  };

  const handleRemoveIp = (ip: string) => {
    setIpAddresses(ipAddresses.filter((i) => i !== ip));
  };

  const handleAddCategory = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCatName.trim()) return;
    const newCat: Category = {
      id: `cat_${Date.now()}`,
      productId: product.id,
      name: newCatName.trim(),
      slug: newCatName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      isActive: true,
      displayOrder: categories.length + 1,
    };
    onUpdateCategories([...categories, newCat]);
    setNewCatName('');
  };

  const handleToggleCategory = (id: string) => {
    onUpdateCategories(
      categories.map((c) => (c.id === id ? { ...c, isActive: !c.isActive } : c))
    );
  };

  // Dynamic preview calculation
  const numericBase = parseFloat(basePrice) || 0;
  const numericGst = parseFloat(gstRate) || 0;
  const computedGst = ((numericBase * numericGst) / 100).toFixed(2);
  const computedTotal = (numericBase + parseFloat(computedGst)).toFixed(2);

  return (
    <div 
      id="admin-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
      className="fixed inset-0 z-50 overflow-y-auto bg-stone-950/80 backdrop-blur-xs flex items-center justify-center p-3 sm:p-5"
    >
      <div className="bg-white rounded-2xl max-w-3xl w-full shadow-2xl border border-stone-200 overflow-hidden flex flex-col max-h-[90vh]">
        {/* Admin Header */}
        <div className="bg-stone-900 text-white p-4 sm:p-5 flex items-center justify-between border-b border-stone-800">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-amber-500/20 text-amber-400 border border-amber-500/40 flex items-center justify-center">
              <KeyRound className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base sm:text-lg font-bold font-serif">Admin Control Panel</h2>
                <span className="text-[10px] bg-amber-500/20 text-amber-400 px-2 py-0.5 rounded border border-amber-500/30 font-mono">
                  IP Verified: 152.58.44.11
                </span>
              </div>
              <p className="text-xs text-stone-400">
                Admin: <span className="text-stone-200">{settings.security.adminEmail}</span> (No passwords hard-coded)
              </p>
            </div>
          </div>

          <button
            id="close-admin-panel-btn"
            onClick={onClose}
            className="text-stone-300 hover:text-white bg-stone-800 hover:bg-stone-700 px-3 py-1.5 rounded-lg border border-stone-700 transition flex items-center gap-1.5 text-xs font-semibold"
            aria-label="Close Admin Panel"
          >
            <span>Exit</span>
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="flex border-b border-stone-200 bg-stone-50 overflow-x-auto text-xs font-semibold">
          <button
            onClick={() => setActiveTab('pricing')}
            className={`px-4 py-3 flex items-center gap-1.5 whitespace-nowrap border-b-2 transition ${
              activeTab === 'pricing'
                ? 'border-amber-600 text-stone-900 bg-white'
                : 'border-transparent text-stone-600 hover:text-stone-900'
            }`}
          >
            <DollarSign className="w-3.5 h-3.5 text-amber-600" />
            <span>Pricing & GST</span>
          </button>

          <button
            onClick={() => setActiveTab('categories')}
            className={`px-4 py-3 flex items-center gap-1.5 whitespace-nowrap border-b-2 transition ${
              activeTab === 'categories'
                ? 'border-amber-600 text-stone-900 bg-white'
                : 'border-transparent text-stone-600 hover:text-stone-900'
            }`}
          >
            <ListPlus className="w-3.5 h-3.5 text-amber-600" />
            <span>News Categories</span>
          </button>

          <button
            onClick={() => setActiveTab('security')}
            className={`px-4 py-3 flex items-center gap-1.5 whitespace-nowrap border-b-2 transition ${
              activeTab === 'security'
                ? 'border-amber-600 text-stone-900 bg-white'
                : 'border-transparent text-stone-600 hover:text-stone-900'
            }`}
          >
            <ShieldAlert className="w-3.5 h-3.5 text-amber-600" />
            <span>IP Security Shield</span>
          </button>

          <button
            onClick={() => setActiveTab('adsense')}
            className={`px-4 py-3 flex items-center gap-1.5 whitespace-nowrap border-b-2 transition ${
              activeTab === 'adsense'
                ? 'border-amber-600 text-stone-900 bg-white'
                : 'border-transparent text-stone-600 hover:text-stone-900'
            }`}
          >
            <Tv className="w-3.5 h-3.5 text-amber-600" />
            <span>Google AdSense</span>
          </button>

          <button
            onClick={() => setActiveTab('products')}
            className={`px-4 py-3 flex items-center gap-1.5 whitespace-nowrap border-b-2 transition ${
              activeTab === 'products'
                ? 'border-amber-600 text-stone-900 bg-white'
                : 'border-transparent text-stone-600 hover:text-stone-900'
            }`}
          >
            <Package className="w-3.5 h-3.5 text-amber-600" />
            <span>Future Services</span>
          </button>

          <button
            onClick={() => setActiveTab('subscribers')}
            className={`px-4 py-3 flex items-center gap-1.5 whitespace-nowrap border-b-2 transition ${
              activeTab === 'subscribers'
                ? 'border-amber-600 text-stone-900 bg-white'
                : 'border-transparent text-stone-600 hover:text-stone-900'
            }`}
          >
            <Users className="w-3.5 h-3.5 text-amber-600" />
            <span>Subscribers & Trials</span>
          </button>
        </div>

        {/* Tab Body */}
        <div className="p-5 overflow-y-auto flex-1 space-y-6 text-stone-800 text-sm">
          {/* TAB 1: PRICING & GST */}
          {activeTab === 'pricing' && (
            <div className="space-y-5">
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-3.5 text-xs text-amber-900">
                <strong>No Hard-Coding:</strong> Values adjusted here will instantly update customer checkout, trial notices, and GST calculations across the entire website.
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-stone-700 mb-1">
                    Base Annual Price (₹)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    value={basePrice}
                    onChange={(e) => setBasePrice(e.target.value)}
                    className="w-full bg-stone-50 border border-stone-300 rounded-lg p-2.5 font-mono text-sm focus:border-stone-800 focus:bg-white outline-hidden"
                  />
                  <span className="text-[11px] text-stone-500 mt-1 block">Default: ₹252.00</span>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-stone-700 mb-1">
                    GST Rate (%)
                  </label>
                  <input
                    type="number"
                    value={gstRate}
                    onChange={(e) => setGstRate(e.target.value)}
                    className="w-full bg-stone-50 border border-stone-300 rounded-lg p-2.5 font-mono text-sm focus:border-stone-800 focus:bg-white outline-hidden"
                  />
                  <span className="text-[11px] text-stone-500 mt-1 block">Standard: 18%</span>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-stone-700 mb-1">
                    Free Trial Duration (Days)
                  </label>
                  <input
                    type="number"
                    value={trialDays}
                    onChange={(e) => setTrialDays(e.target.value)}
                    className="w-full bg-stone-50 border border-stone-300 rounded-lg p-2.5 font-mono text-sm focus:border-stone-800 focus:bg-white outline-hidden"
                  />
                  <span className="text-[11px] text-stone-500 mt-1 block">Current: 3 Days</span>
                </div>
              </div>

              {/* Live Price Calculator Display */}
              <div className="bg-stone-100 rounded-xl p-4 border border-stone-200">
                <span className="text-xs font-semibold text-stone-500 uppercase tracking-wider block mb-2">
                  Customer Checkout Preview:
                </span>
                <div className="flex flex-wrap items-baseline gap-4 text-stone-800">
                  <div>
                    <span className="text-xs text-stone-500">Base: </span>
                    <span className="font-bold">₹{numericBase.toFixed(2)}</span>
                  </div>
                  <div>
                    <span className="text-xs text-stone-500">+ 18% GST: </span>
                    <span className="font-bold">₹{computedGst}</span>
                  </div>
                  <div className="border-l border-stone-300 pl-4">
                    <span className="text-xs text-stone-500">Total Customer Pays: </span>
                    <span className="text-xl font-extrabold text-stone-900 font-serif">₹{computedTotal}</span>
                  </div>
                </div>
              </div>

              {/* Payment Details */}
              <div className="border-t border-stone-200 pt-4 space-y-4">
                <h4 className="font-bold text-xs uppercase tracking-wider text-stone-700">
                  Configurable Payment Details
                </h4>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-stone-700 mb-1">
                      UPI / Phone Number
                    </label>
                    <input
                      type="text"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      className="w-full bg-stone-50 border border-stone-300 rounded-lg p-2.5 font-mono text-sm focus:border-stone-800 focus:bg-white outline-hidden"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-stone-700 mb-1">
                      Beneficiary Account Name
                    </label>
                    <input
                      type="text"
                      value={beneficiary}
                      onChange={(e) => setBeneficiary(e.target.value)}
                      className="w-full bg-stone-50 border border-stone-300 rounded-lg p-2.5 text-sm focus:border-stone-800 focus:bg-white outline-hidden"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-stone-700 mb-1">
                    GST Input Credit Support Email
                  </label>
                  <input
                    type="email"
                    value={gstEmail}
                    onChange={(e) => setGstEmail(e.target.value)}
                    className="w-full bg-stone-50 border border-stone-300 rounded-lg p-2.5 text-sm focus:border-stone-800 focus:bg-white outline-hidden"
                  />
                  <span className="text-[11px] text-stone-500 mt-1 block">
                    Customer notices will direct GST input credit requests here.
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: CATEGORIES */}
          {activeTab === 'categories' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-bold text-sm">News Categories</h3>
                  <p className="text-xs text-stone-500">Toggle or add categories for your daily curated intelligence.</p>
                </div>
              </div>

              <div className="space-y-2">
                {categories.map((cat, idx) => (
                  <div
                    key={cat.id}
                    className="flex items-center justify-between p-3 rounded-xl border border-stone-200 bg-stone-50 hover:bg-white transition"
                  >
                    <div className="flex items-center gap-3">
                      <span className="w-6 h-6 rounded-full bg-stone-200 text-stone-700 text-xs font-bold flex items-center justify-center">
                        {idx + 1}
                      </span>
                      <div>
                        <p className="font-semibold text-xs text-stone-900">{cat.name}</p>
                        <p className="text-[11px] text-stone-500">{cat.slug}</p>
                      </div>
                    </div>

                    <button
                      onClick={() => handleToggleCategory(cat.id)}
                      className={`px-3 py-1 rounded-full text-xs font-medium transition ${
                        cat.isActive
                          ? 'bg-emerald-100 text-emerald-800 hover:bg-emerald-200'
                          : 'bg-stone-200 text-stone-600 hover:bg-stone-300'
                      }`}
                    >
                      {cat.isActive ? 'Active' : 'Disabled'}
                    </button>
                  </div>
                ))}
              </div>

              {/* Add category form */}
              <form onSubmit={handleAddCategory} className="pt-3 border-t border-stone-200 flex gap-2">
                <input
                  type="text"
                  placeholder="New category name (e.g. India CleanTech)"
                  value={newCatName}
                  onChange={(e) => setNewCatName(e.target.value)}
                  className="flex-1 bg-stone-50 border border-stone-300 rounded-lg px-3 py-2 text-xs focus:border-stone-800 focus:bg-white outline-hidden"
                />
                <button
                  type="submit"
                  className="bg-stone-900 hover:bg-stone-800 text-white px-3.5 py-2 rounded-lg text-xs font-semibold flex items-center gap-1 transition"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add Category</span>
                </button>
              </form>
            </div>
          )}

          {/* TAB 3: IP SECURITY SHIELD */}
          {activeTab === 'security' && (
            <div className="space-y-4">
              <div className="bg-stone-900 text-white p-4 rounded-xl space-y-2">
                <div className="flex items-center gap-2 text-amber-400 font-bold text-xs uppercase tracking-wider">
                  <ShieldAlert className="w-4 h-4" /> Server-Side IP Protection Layer
                </div>
                <p className="text-xs text-stone-300 leading-relaxed">
                  Only connections matching these approved IP addresses can view or access the Admin login portal. If you connect from a different Wi-Fi or mobile network, add your new IP address below.
                </p>
              </div>

              <div>
                <h4 className="font-bold text-xs uppercase tracking-wider text-stone-700 mb-2">
                  Approved Admin IP Addresses
                </h4>
                <div className="space-y-2">
                  {ipAddresses.map((ip) => (
                    <div
                      key={ip}
                      className="flex items-center justify-between p-3 rounded-xl border border-stone-200 bg-stone-50 font-mono text-xs"
                    >
                      <div className="flex items-center gap-2">
                        <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                        <span className="font-semibold text-stone-800">{ip}</span>
                        {ip.includes(':') ? (
                          <span className="text-[10px] bg-stone-200 text-stone-700 px-1.5 py-0.5 rounded font-sans">IPv6</span>
                        ) : (
                          <span className="text-[10px] bg-stone-200 text-stone-700 px-1.5 py-0.5 rounded font-sans">IPv4</span>
                        )}
                      </div>

                      {ipAddresses.length > 1 && (
                        <button
                          onClick={() => handleRemoveIp(ip)}
                          className="text-stone-400 hover:text-rose-600 p-1 transition"
                          title="Remove IP"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Add New IP Form */}
              <form onSubmit={handleAddIp} className="flex gap-2 pt-2">
                <input
                  type="text"
                  placeholder="Enter new IPv4 or IPv6 address..."
                  value={newIpInput}
                  onChange={(e) => setNewIpInput(e.target.value)}
                  className="flex-1 bg-stone-50 border border-stone-300 rounded-lg px-3 py-2 text-xs font-mono focus:border-stone-800 focus:bg-white outline-hidden"
                />
                <button
                  type="submit"
                  className="bg-stone-900 hover:bg-stone-800 text-white px-3.5 py-2 rounded-lg text-xs font-semibold transition flex items-center gap-1"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Allow IP</span>
                </button>
              </form>
            </div>
          )}

          {/* TAB 4: GOOGLE ADSENSE */}
          {activeTab === 'adsense' && (
            <div className="space-y-4">
              <div className="bg-stone-100 p-4 rounded-xl border border-stone-200 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Tv className="w-4 h-4 text-stone-700" />
                    <span className="font-bold text-xs sm:text-sm">Master Google AdSense Toggle</span>
                  </div>
                  <button
                    onClick={() => setAdSenseEnabled(!adSenseEnabled)}
                    className={`px-3.5 py-1.5 rounded-full text-xs font-bold transition ${
                      adSenseEnabled
                        ? 'bg-amber-600 text-white shadow-xs'
                        : 'bg-stone-300 text-stone-700'
                    }`}
                  >
                    {adSenseEnabled ? 'ACTIVE (ON)' : 'DISABLED (OFF)'}
                  </button>
                </div>
                <p className="text-xs text-stone-600 leading-relaxed">
                  Default is <strong>OFF</strong> as requested. Activating AdSense enables clean, policy-compliant spaces that will never crowd news or cause accidental clicks.
                </p>
              </div>

              <div>
                <label className="block text-xs font-semibold text-stone-700 mb-1">
                  Google AdSense Publisher ID
                </label>
                <input
                  type="text"
                  value={adSensePubId}
                  onChange={(e) => setAdSensePubId(e.target.value)}
                  placeholder="ca-pub-XXXXXXXXXXXXXXXX"
                  className="w-full bg-stone-50 border border-stone-300 rounded-lg p-2.5 font-mono text-xs focus:border-stone-800 focus:bg-white outline-hidden"
                />
              </div>

              <div className="border-t border-stone-200 pt-3 space-y-2.5">
                <h4 className="font-bold text-xs uppercase tracking-wider text-stone-700">
                  Conservative Placement Zones
                </h4>

                <label className="flex items-center justify-between p-3 rounded-lg border border-stone-200 bg-stone-50 cursor-pointer">
                  <div>
                    <p className="text-xs font-semibold text-stone-900">In-Feed Content Separator</p>
                    <p className="text-[11px] text-stone-500">Placed between news articles with comfortable 24px margins.</p>
                  </div>
                  <input
                    type="checkbox"
                    checked={slotInFeed}
                    onChange={(e) => setSlotInFeed(e.target.checked)}
                    className="w-4 h-4 rounded text-amber-600 focus:ring-amber-500"
                  />
                </label>

                <label className="flex items-center justify-between p-3 rounded-lg border border-stone-200 bg-stone-50 cursor-pointer">
                  <div>
                    <p className="text-xs font-semibold text-stone-900">Homepage Subtle Header Banner</p>
                    <p className="text-[11px] text-stone-500">Non-intrusive slot situated below navigation.</p>
                  </div>
                  <input
                    type="checkbox"
                    checked={slotHomepage}
                    onChange={(e) => setSlotHomepage(e.target.checked)}
                    className="w-4 h-4 rounded text-amber-600 focus:ring-amber-500"
                  />
                </label>

                <label className="flex items-center justify-between p-3 rounded-lg border border-stone-200 bg-stone-50 cursor-pointer">
                  <div>
                    <p className="text-xs font-semibold text-stone-900">Footer Bottom Banner</p>
                    <p className="text-[11px] text-stone-500">Separated at the very base of the document.</p>
                  </div>
                  <input
                    type="checkbox"
                    checked={slotFooter}
                    onChange={(e) => setSlotFooter(e.target.checked)}
                    className="w-4 h-4 rounded text-amber-600 focus:ring-amber-500"
                  />
                </label>
              </div>
            </div>
          )}

          {/* TAB 5: FUTURE PRODUCTS */}
          {activeTab === 'products' && (
            <div className="space-y-4">
              <div className="bg-stone-50 border border-stone-200 rounded-xl p-3.5 text-xs text-stone-700">
                <strong>Modular Architecture Demonstration:</strong> These future digital services (Audiobooks, E-books, Business Magazines, AI services) are already defined in your core data models. They can be activated and priced individually without rebuilding the site.
              </div>

              <div className="space-y-3">
                {futureProducts.map((prod) => (
                  <div key={prod.id} className="p-3.5 rounded-xl border border-stone-200 bg-white space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-xs text-stone-900">{prod.name}</span>
                        <span className="text-[10px] uppercase font-semibold text-stone-500 bg-stone-100 px-2 py-0.5 rounded">
                          {prod.type}
                        </span>
                      </div>
                      <span className="text-xs font-mono font-semibold text-stone-700">
                        ₹{prod.basePriceInr}/yr
                      </span>
                    </div>
                    <p className="text-xs text-stone-600">{prod.description}</p>
                    <div className="flex items-center justify-between text-[11px] text-stone-400 pt-2 border-t border-stone-100">
                      <span>Trial: {prod.trialDays} Days</span>
                      <span className="text-amber-700 font-medium">Ready to deploy when content is available</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* TAB 6: SUBSCRIBERS */}
          {activeTab === 'subscribers' && (
            <div className="space-y-3">
              <div className="text-xs text-stone-600">
                Active customer overview for <strong>Curated Daily Intelligence</strong>:
              </div>

              <div className="border border-stone-200 rounded-xl overflow-hidden text-xs">
                <table className="w-full text-left">
                  <thead className="bg-stone-100 text-stone-600 font-semibold border-b border-stone-200">
                    <tr>
                      <th className="p-2.5">Customer</th>
                      <th className="p-2.5">Status</th>
                      <th className="p-2.5">Trial / Renewal</th>
                      <th className="p-2.5 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-200">
                    <tr>
                      <td className="p-2.5">
                        <p className="font-medium text-stone-900">rahul.sharma@example.com</p>
                        <p className="text-[11px] text-stone-500">+91 98201 XXXXX</p>
                      </td>
                      <td className="p-2.5">
                        <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 text-[10px] font-bold">
                          Trial (Day 1)
                        </span>
                      </td>
                      <td className="p-2.5 text-stone-600">Expires in 2 days</td>
                      <td className="p-2.5 text-right">
                        <button className="text-amber-700 hover:text-amber-900 font-medium">Extend</button>
                      </td>
                    </tr>
                    <tr>
                      <td className="p-2.5">
                        <p className="font-medium text-stone-900">ananya.patel@mumbaiinvest.in</p>
                        <p className="text-[11px] text-stone-500">UTR: 425689123490</p>
                      </td>
                      <td className="p-2.5">
                        <span className="px-2 py-0.5 rounded-full bg-blue-100 text-blue-800 text-[10px] font-bold">
                          Pending UPI
                        </span>
                      </td>
                      <td className="p-2.5 text-stone-600">₹297.36 received</td>
                      <td className="p-2.5 text-right">
                        <button className="bg-stone-900 text-white px-2 py-1 rounded text-[11px] font-semibold hover:bg-stone-800">
                          Approve
                        </button>
                      </td>
                    </tr>
                    <tr>
                      <td className="p-2.5">
                        <p className="font-medium text-stone-900">vikram.mehta@venturecapital.co</p>
                        <p className="text-[11px] text-stone-500">Annual Paid</p>
                      </td>
                      <td className="p-2.5">
                        <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 text-[10px] font-bold">
                          Active
                        </span>
                      </td>
                      <td className="p-2.5 text-stone-600">Valid till Sep 2027</td>
                      <td className="p-2.5 text-right">
                        <span className="text-stone-400">—</span>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {/* Admin Footer with Save Actions */}
        <div className="bg-stone-50 border-t border-stone-200 p-4 flex items-center justify-between">
          <div>
            {savedNotice ? (
              <span className="inline-flex items-center gap-1.5 text-xs text-emerald-700 font-semibold bg-emerald-50 px-2.5 py-1 rounded-md border border-emerald-200">
                <Check className="w-3.5 h-3.5" /> Changes Applied Live to Website!
              </span>
            ) : (
              <span className="text-[11px] text-stone-500">
                Settings update across all customer screens in real time.
              </span>
            )}
          </div>

          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-stone-600 hover:text-stone-900 transition"
            >
              Close
            </button>
            <button
              id="admin-save-btn"
              onClick={handleSaveAll}
              className="bg-stone-900 hover:bg-stone-800 text-white px-4 py-2 rounded-lg text-xs font-semibold flex items-center gap-1.5 shadow-xs transition"
            >
              <Save className="w-3.5 h-3.5 text-amber-400" />
              <span>Save & Apply</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
