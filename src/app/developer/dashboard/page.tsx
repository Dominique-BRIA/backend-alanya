'use client';

import React, { useState, useEffect } from 'react';

interface ApiKeyItem {
  id: string;
  prefix: string;
  name: string;
  type: 'SANDBOX' | 'LIVE';
  isActive: boolean;
  lastUsedAt: string | null;
  createdAt: string;
}

interface DeveloperData {
  id: string;
  balanceCredits: string;
  holdCredits: string;
  companyName: string | null;
}

export default function DeveloperDashboardPage() {
  const [developer, setDeveloper] = useState<DeveloperData | null>(null);
  const [apiKeys, setApiKeys] = useState<ApiKeyItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [keyName, setKeyName] = useState('');
  const [keyType, setKeyType] = useState<'SANDBOX' | 'LIVE'>('SANDBOX');
  const [generatedRawKey, setGeneratedRawKey] = useState<string | null>(null);
  const [rechargeMsg, setRechargeMsg] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    fetchDeveloperData();
  }, []);

  const fetchDeveloperData = async () => {
    try {
      setLoading(true);
      setError(null);
      const token = localStorage.getItem('accessToken') || '';
      const res = await fetch('/api/developer/keys', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      const data = await res.json();
      if (data.ok) {
        setDeveloper(data.data.developer);
        setApiKeys(data.data.apiKeys || []);
      } else {
        setError(data.error || 'Erreur lors du chargement des données développeur');
      }
    } catch (err: any) {
      setError('Impossible de se connecter au serveur');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateKey = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setIsSubmitting(true);
      setError(null);
      const token = localStorage.getItem('accessToken') || '';
      const res = await fetch('/api/developer/keys', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name: keyName || 'Ma Clé API', type: keyType }),
      });
      const data = await res.json();
      if (data.ok) {
        setGeneratedRawKey(data.data.rawKey);
        setKeyName('');
        fetchDeveloperData();
      } else {
        setError(data.error || 'Erreur de génération de la clé');
      }
    } catch (err) {
      setError('Erreur réseau lors de la création');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRevokeKey = async (keyId: string) => {
    if (!confirm('Voulez-vous vraiment révoquer cette clé API ? Elle ne pourra plus être utilisée.')) return;
    try {
      const token = localStorage.getItem('accessToken') || '';
      const res = await fetch('/api/developer/keys', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ keyId }),
      });
      const data = await res.json();
      if (data.ok) {
        fetchDeveloperData();
      } else {
        alert(data.error || 'Erreur lors de la révocation');
      }
    } catch (err) {
      alert('Erreur réseau');
    }
  };

  const handleSandboxRecharge = async (pack: 'STARTER' | 'PRO' | 'ENTERPRISE') => {
    try {
      setRechargeMsg(null);
      const token = localStorage.getItem('accessToken') || '';
      const res = await fetch('/api/developer/billing/sandbox', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ pack }),
      });
      const data = await res.json();
      if (data.ok) {
        setRechargeMsg(data.data.message);
        fetchDeveloperData();
      } else {
        alert(data.error || 'Erreur de recharge');
      }
    } catch (err) {
      alert('Erreur de communication');
    }
  };

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', background: '#0F172A', color: '#F8FAFC', padding: '40px', fontFamily: 'sans-serif' }}>
        <h2>Chargement de la Console Développeur Alanya...</h2>
      </div>
    );
  }

  const balance = Number(developer?.balanceCredits || 0);

  return (
    <div style={{ minHeight: '100vh', background: '#0F172A', color: '#F8FAFC', padding: '40px', fontFamily: 'sans-serif' }}>
      <header style={{ marginBottom: '32px', borderBottom: '1px solid #1E293B', paddingBottom: '20px' }}>
        <h1 style={{ fontSize: '28px', color: '#38BDF8', margin: 0 }}>⚡ Console Développeur Alanya & Billing API</h1>
        <p style={{ color: '#94A3B8', marginTop: '8px' }}>
          Gérez vos clés d'API, suivez votre consommation de messages X et d'appels Y en temps réel.
        </p>
      </header>

      {error && (
        <div style={{ background: '#7F1D1D', color: '#FECACA', padding: '16px', borderRadius: '8px', marginBottom: '24px' }}>
          ⚠️ {error}
        </div>
      )}

      {rechargeMsg && (
        <div style={{ background: '#064E3B', color: '#A7F3D0', padding: '16px', borderRadius: '8px', marginBottom: '24px' }}>
          ✅ {rechargeMsg}
        </div>
      )}

      {/* RÉSULTAT NOUVELLE CLÉ SÉCURISÉE */}
      {generatedRawKey && (
        <div style={{ background: '#1E1B4B', border: '2px solid #6366F1', padding: '24px', borderRadius: '12px', marginBottom: '32px' }}>
          <h3 style={{ color: '#A5B4FC', marginTop: 0 }}>🔑 Nouvelle Clé API Générée avec Succès !</h3>
          <p style={{ color: '#E0E7FF' }}>
            <strong>IMPORTANT :</strong> Conservez cette clé en lieu sûr. Elle n'apparaîtra <strong>QU'UNE SEULE ET UNIQUE FOIS</strong>.
          </p>
          <div style={{ background: '#090D16', padding: '14px', borderRadius: '8px', fontFamily: 'monospace', fontSize: '16px', color: '#34D399', wordBreak: 'break-all' }}>
            {generatedRawKey}
          </div>
          <button
            onClick={() => {
              navigator.clipboard.writeText(generatedRawKey);
              alert('Clé copiée dans le presse-papier !');
            }}
            style={{ marginTop: '16px', padding: '10px 18px', background: '#4F46E5', color: '#FFF', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}
          >
            📋 Copier la Clé
          </button>
          <button
            onClick={() => setGeneratedRawKey(null)}
            style={{ marginLeft: '12px', marginTop: '16px', padding: '10px 18px', background: '#334155', color: '#FFF', border: 'none', borderRadius: '6px', cursor: 'pointer' }}
          >
            Fermer
          </button>
        </div>
      )}

      {/* GRILLE SOLDE & CARTE COMPTEUR */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '20px', marginBottom: '32px' }}>
        <div style={{ background: '#1E293B', padding: '24px', borderRadius: '12px', border: '1px solid #334155' }}>
          <h3 style={{ margin: 0, fontSize: '14px', color: '#94A3B8', textTransform: 'uppercase' }}>Solde de Crédits Disponibles</h3>
          <div style={{ fontSize: '36px', fontWeight: 'bold', color: '#38BDF8', marginTop: '8px' }}>
            {balance.toLocaleString()} <span style={{ fontSize: '18px', color: '#64748B' }}>ALC</span>
          </div>
          <p style={{ color: '#94A3B8', fontSize: '13px', marginTop: '8px', marginBottom: 0 }}>
            Équivalent à <strong>{balance} Messages</strong> ou <strong>{Math.floor(balance / 10)} Min d'appels Audio/Vidéo</strong>
          </p>
        </div>

        <div style={{ background: '#1E293B', padding: '24px', borderRadius: '12px', border: '1px solid #334155' }}>
          <h3 style={{ margin: 0, fontSize: '14px', color: '#94A3B8', textTransform: 'uppercase' }}>Crédits sous Réservation (HOLD)</h3>
          <div style={{ fontSize: '36px', fontWeight: 'bold', color: '#F59E0B', marginTop: '8px' }}>
            {Number(developer?.holdCredits || 0).toLocaleString()} <span style={{ fontSize: '18px', color: '#64748B' }}>ALC</span>
          </div>
          <p style={{ color: '#94A3B8', fontSize: '13px', marginTop: '8px', marginBottom: 0 }}>
            Réservations temporaires pour les sessions WebRTC actives
          </p>
        </div>
      </div>

      {/* RECHARGE SANDBOX GRATUITE */}
      <div style={{ background: '#1E293B', padding: '24px', borderRadius: '12px', border: '1px solid #334155', marginBottom: '32px' }}>
        <h3 style={{ color: '#F8FAFC', marginTop: 0 }}>🎁 Recharge Gratuit / Mode Sandbox</h3>
        <p style={{ color: '#94A3B8', fontSize: '14px' }}>
          Testez le système de facturation et de quota sans aucun frais en créditant votre portefeuille en 1-click :
        </p>
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginTop: '16px' }}>
          <button
            onClick={() => handleSandboxRecharge('STARTER')}
            style={{ padding: '12px 20px', background: '#0284C7', color: '#FFF', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}
          >
            +1 000 Crédits Gratuit (Starter)
          </button>
          <button
            onClick={() => handleSandboxRecharge('PRO')}
            style={{ padding: '12px 20px', background: '#0D9488', color: '#FFF', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}
          >
            +5 750 Crédits Gratuit (+15% Bonus Pro)
          </button>
          <button
            onClick={() => handleSandboxRecharge('ENTERPRISE')}
            style={{ padding: '12px 20px', background: '#7C3AED', color: '#FFF', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}
          >
            +26 000 Crédits Gratuit (+30% Bonus Enterprise)
          </button>
        </div>
      </div>

      {/* CRÉATION DE CLÉ API */}
      <div style={{ background: '#1E293B', padding: '24px', borderRadius: '12px', border: '1px solid #334155', marginBottom: '32px' }}>
        <h3 style={{ color: '#F8FAFC', marginTop: 0 }}>➕ Créer une nouvelle Clé API</h3>
        <form onSubmit={handleCreateKey} style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            type="text"
            placeholder="Nom de la clé (ex: Production App)"
            value={keyName}
            onChange={(e) => setKeyName(e.target.value)}
            style={{ padding: '10px 14px', borderRadius: '6px', border: '1px solid #475569', background: '#0F172A', color: '#FFF', flex: '1', minWidth: '220px' }}
            required
          />
          <select
            value={keyType}
            onChange={(e) => setKeyType(e.target.value as any)}
            style={{ padding: '10px 14px', borderRadius: '6px', border: '1px solid #475569', background: '#0F172A', color: '#FFF' }}
          >
            <option value="SANDBOX">Sandbox (ak_test_...)</option>
            <option value="LIVE">Production (ak_live_...)</option>
          </select>
          <button
            type="submit"
            disabled={isSubmitting}
            style={{ padding: '10px 20px', background: '#16A34A', color: '#FFF', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}
          >
            {isSubmitting ? 'Génération...' : 'Générer la Clé'}
          </button>
        </form>
      </div>

      {/* LISTE DES CLÉS API */}
      <div style={{ background: '#1E293B', padding: '24px', borderRadius: '12px', border: '1px solid #334155', marginBottom: '32px' }}>
        <h3 style={{ color: '#F8FAFC', marginTop: 0 }}>🔑 Vos Clés d'API Active ({apiKeys.length})</h3>
        {apiKeys.length === 0 ? (
          <p style={{ color: '#64748B' }}>Aucune clé d'API créée pour le moment.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', marginTop: '12px' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #334155', color: '#94A3B8', fontSize: '13px' }}>
                  <th style={{ padding: '10px' }}>NOM</th>
                  <th style={{ padding: '10px' }}>PRÉFIXE</th>
                  <th style={{ padding: '10px' }}>TYPE</th>
                  <th style={{ padding: '10px' }}>STATUT</th>
                  <th style={{ padding: '10px' }}>CRÉÉE LE</th>
                  <th style={{ padding: '10px' }}>ACTION</th>
                </tr>
              </thead>
              <tbody>
                {apiKeys.map((k) => (
                  <tr key={k.id} style={{ borderBottom: '1px solid #1E293B', opacity: k.isActive ? 1 : 0.5 }}>
                    <td style={{ padding: '12px 10px', fontWeight: 'bold' }}>{k.name}</td>
                    <td style={{ padding: '12px 10px', fontFamily: 'monospace', color: '#38BDF8' }}>
                      {k.prefix}_••••••••••••
                    </td>
                    <td style={{ padding: '12px 10px' }}>
                      <span style={{ padding: '4px 8px', borderRadius: '4px', fontSize: '12px', background: k.type === 'SANDBOX' ? '#0369A1' : '#15803D', color: '#FFF' }}>
                        {k.type}
                      </span>
                    </td>
                    <td style={{ padding: '12px 10px' }}>
                      <span style={{ color: k.isActive ? '#4ADE80' : '#F87171' }}>
                        {k.isActive ? '● Active' : '○ Révoquée'}
                      </span>
                    </td>
                    <td style={{ padding: '12px 10px', color: '#94A3B8', fontSize: '13px' }}>
                      {new Date(k.createdAt).toLocaleDateString()}
                    </td>
                    <td style={{ padding: '12px 10px' }}>
                      {k.isActive && (
                        <button
                          onClick={() => handleRevokeKey(k.id)}
                          style={{ padding: '6px 12px', background: '#991B1B', color: '#FFF', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}
                        >
                          Révoquer
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* DOCUMENTATION INTERACTIVE Prêt-à-copier */}
      <div style={{ background: '#1E293B', padding: '24px', borderRadius: '12px', border: '1px solid #334155' }}>
        <h3 style={{ color: '#F8FAFC', marginTop: 0 }}>📖 Exemple de Requête cURL API Développeur</h3>
        <p style={{ color: '#94A3B8', fontSize: '14px' }}>
          Testez l'envoi d'un message via cURL ou Postman en passant votre clé API :
        </p>
        <div style={{ background: '#090D16', padding: '16px', borderRadius: '8px', fontFamily: 'monospace', fontSize: '13px', color: '#F1F5F9', overflowX: 'auto' }}>
{`curl -X POST https://alanyavox.com/api/v1/messages/send \\
  -H "Content-Type: application/json" \\
  -H "X-Api-Key: ak_test_votre_cle_secrete_ici" \\
  -d '{
    "recipientNumber": "600001",
    "content": "Bonjour depuis l'API Développeur Alanya !"
  }'`}
        </div>
      </div>
    </div>
  );
}
