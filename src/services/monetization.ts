import { Capacitor } from '@capacitor/core';
import {
  AdMob,
  AdmobConsentStatus,
  BannerAdPosition,
  BannerAdSize,
} from '@capacitor-community/admob';
import { FirebaseAnalytics } from '@capacitor-community/firebase-analytics';
import { ADMOB_AD_UNIT_IDS } from './monetizationConfig.ts';

let admobInitialized = false;
let servicesInitialized = false;
let analyticsConsentApplied = false;
let canRequestAdsState = false;
let bannerVisible = false;
let lastInterstitialShownAt = 0;
const INTERSTITIAL_MIN_INTERVAL_MS = 180_000; // 3-minute respectful cooldown between interstitials

export function isAdMobReady(): boolean {
  return admobInitialized && canRequestAdsState;
}

export function isAnalyticsActive(): boolean {
  return analyticsConsentApplied;
}

export async function initializeAppServices(): Promise<void> {
  if (servicesInitialized) return;
  servicesInitialized = true;

  // Analytics stays disabled until the app obtains the user's privacy choice.
  let analyticsAllowed = false;
  try {
    analyticsAllowed = localStorage.getItem('mta_analytics_consent') === 'granted';
  } catch {
    // If local storage is unavailable, optional analytics remain disabled.
  }

  analyticsConsentApplied = false;
  try {
    await FirebaseAnalytics.setCollectionEnabled({ enabled: analyticsAllowed });
    analyticsConsentApplied = analyticsAllowed;
  } catch (error) {
    analyticsConsentApplied = false;
    console.warn('[MTA] Firebase Analytics setup skipped (web/stub environment):', error);
  }

  // AdMob is available only in native Android/iOS builds.
  if (!Capacitor.isNativePlatform() || admobInitialized) return;

  try {
    let consentInfo = await AdMob.requestConsentInfo();

    if (
      consentInfo.isConsentFormAvailable &&
      consentInfo.status === AdmobConsentStatus.REQUIRED
    ) {
      consentInfo = await AdMob.showConsentForm();
    }

    if (!consentInfo.canRequestAds) {
      console.info('[MTA] AdMob ads are not allowed by the current user consent state.');
      canRequestAdsState = false;
      return;
    }

    canRequestAdsState = true;
    await AdMob.initialize();
    admobInitialized = true;
    console.info('[MTA] AdMob initialized successfully in compliant state.');
  } catch (error) {
    console.warn('[MTA] AdMob initialization failed; app startup will continue:', error);
  }
}

export async function setAnalyticsConsent(accepted: boolean): Promise<void> {
  // Persist the choice first. If storage fails, do not enable optional analytics.
  try {
    localStorage.setItem('mta_analytics_consent', accepted ? 'granted' : 'denied');
  } catch (error) {
    throw new Error('Could not save the privacy preference.', { cause: error });
  }

  analyticsConsentApplied = false;
  try {
    await FirebaseAnalytics.setCollectionEnabled({ enabled: accepted });
    analyticsConsentApplied = accepted;
  } catch (error) {
    analyticsConsentApplied = false;
    console.warn('[MTA] Could not update Analytics consent in native SDK:', error);
  }

  if (accepted) {
    void logAnalyticsEvent('consent_granted', { timestamp: Date.now() });
  }
}

export async function logAnalyticsEvent(
  name: string,
  params?: Record<string, string | number | boolean>,
): Promise<void> {
  // Never record optional events unless the user explicitly granted consent.
  try {
    if (!analyticsConsentApplied || localStorage.getItem('mta_analytics_consent') !== 'granted') return;
  } catch {
    return;
  }

  try {
    await FirebaseAnalytics.logEvent({ name, params: params || {} });
  } catch (error) {
    // Non-fatal fallback for web development preview
    if (import.meta.env.DEV) {
      console.debug(`[MTA Analytics DEV] Event '${name}':`, params);
    }
  }
}

/**
 * Displays a non-intrusive standard banner ad (bottom anchored by default).
 * Complies with UMP consent checks and native platform constraints.
 */
export async function showBannerAd(
  position: 'bottom' | 'top' = 'bottom'
): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) {
    return false;
  }
  if (!admobInitialized || !canRequestAdsState) {
    console.info('[MTA] Banner skipped: AdMob not ready or user consent not granted.');
    return false;
  }
  try {
    await AdMob.showBanner({
      adId: ADMOB_AD_UNIT_IDS.banner,
      adSize: BannerAdSize.BANNER,
      position: position === 'top' ? BannerAdPosition.TOP_CENTER : BannerAdPosition.BOTTOM_CENTER,
      margin: 0,
      isTesting: import.meta.env.DEV,
    });
    bannerVisible = true;
    void logAnalyticsEvent('ad_banner_shown', { position });
    return true;
  } catch (err) {
    console.warn('[MTA] showBanner error:', err);
    return false;
  }
}

/**
 * Hides or removes the banner ad cleanly.
 */
export async function hideBannerAd(): Promise<void> {
  if (!Capacitor.isNativePlatform() || !bannerVisible) return;
  try {
    await AdMob.hideBanner();
    bannerVisible = false;
  } catch (err) {
    console.warn('[MTA] hideBanner error:', err);
  }
}

/**
 * Shows an interstitial ad politely with frequency capping.
 * Never interrupts active reading or core critical workflows.
 */
export async function showInterstitialAd(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) {
    return false;
  }
  if (!admobInitialized || !canRequestAdsState) {
    return false;
  }

  const now = Date.now();
  if (now - lastInterstitialShownAt < INTERSTITIAL_MIN_INTERVAL_MS) {
    // Respect user experience by enforcing minimum intervals
    return false;
  }

  try {
    await AdMob.prepareInterstitial({
      adId: ADMOB_AD_UNIT_IDS.interstitial,
      isTesting: import.meta.env.DEV,
    });
    await AdMob.showInterstitial();
    lastInterstitialShownAt = Date.now();
    void logAnalyticsEvent('ad_interstitial_shown', { timestamp: lastInterstitialShownAt });
    return true;
  } catch (err) {
    console.warn('[MTA] showInterstitial error:', err);
    return false;
  }
}

/**
 * Shows an optional rewarded ad when the user deliberately chooses to watch one,
 * granting a tangible academic benefit (e.g. unlocking offline package or full syllabus bundle).
 */
export async function showRewardedAd(): Promise<{ success: boolean; reward?: { type: string; amount: number } }> {
  if (!Capacitor.isNativePlatform()) {
    // In web preview or dev, simulate success for testing rewards gracefully
    return { success: true, reward: { type: 'academic_fast_access', amount: 1 } };
  }
  if (!admobInitialized || !canRequestAdsState) {
    return { success: false };
  }

  try {
    await AdMob.prepareRewardVideoAd({
      adId: ADMOB_AD_UNIT_IDS.rewarded,
      isTesting: import.meta.env.DEV,
    });
    const rewardItem = await AdMob.showRewardVideoAd();
    void logAnalyticsEvent('ad_rewarded_completed', {
      reward_type: rewardItem?.type || 'academic_access',
      amount: rewardItem?.amount || 1,
    });
    return {
      success: true,
      reward: {
        type: rewardItem?.type || 'academic_access',
        amount: rewardItem?.amount || 1,
      },
    };
  } catch (err) {
    console.warn('[MTA] showRewardVideoAd error:', err);
    return { success: false };
  }
}
