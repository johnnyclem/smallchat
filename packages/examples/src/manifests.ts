import atlassian from '../manifests/atlassian-manifest.json' with { type: 'json' };
import aws from '../manifests/aws-manifest.json' with { type: 'json' };
import azure from '../manifests/azure-manifest.json' with { type: 'json' };
import braveSearch from '../manifests/brave-search-manifest.json' with { type: 'json' };
import cloudflare from '../manifests/cloudflare-manifest.json' with { type: 'json' };
import elasticsearch from '../manifests/elasticsearch-manifest.json' with { type: 'json' };
import everart from '../manifests/everart-manifest.json' with { type: 'json' };
import everything from '../manifests/everything-manifest.json' with { type: 'json' };
import fetch from '../manifests/fetch-manifest.json' with { type: 'json' };
import figma from '../manifests/figma-manifest.json' with { type: 'json' };
import filesystem from '../manifests/filesystem-manifest.json' with { type: 'json' };
import firebase from '../manifests/firebase-manifest.json' with { type: 'json' };
import git from '../manifests/git-manifest.json' with { type: 'json' };
import github from '../manifests/github-manifest.json' with { type: 'json' };
import gitlab from '../manifests/gitlab-manifest.json' with { type: 'json' };
import googleDrive from '../manifests/google-drive-manifest.json' with { type: 'json' };
import googleMaps from '../manifests/google-maps-manifest.json' with { type: 'json' };
import linear from '../manifests/linear-manifest.json' with { type: 'json' };
import memory from '../manifests/memory-manifest.json' with { type: 'json' };
import mongodb from '../manifests/mongodb-manifest.json' with { type: 'json' };
import notion from '../manifests/notion-manifest.json' with { type: 'json' };
import postgres from '../manifests/postgres-manifest.json' with { type: 'json' };
import puppeteer from '../manifests/puppeteer-manifest.json' with { type: 'json' };
import redis from '../manifests/redis-manifest.json' with { type: 'json' };
import sentry from '../manifests/sentry-manifest.json' with { type: 'json' };
import sequentialThinking from '../manifests/sequential-thinking-manifest.json' with { type: 'json' };
import slack from '../manifests/slack-manifest.json' with { type: 'json' };
import sqlite from '../manifests/sqlite-manifest.json' with { type: 'json' };
import stripe from '../manifests/stripe-manifest.json' with { type: 'json' };
import time from '../manifests/time-manifest.json' with { type: 'json' };

export interface Manifest {
  id: string;
  name: string;
  transportType: string;
  description?: string;
  tools: Array<{
    name: string;
    description: string;
    providerId: string;
    transportType: string;
    inputSchema: Record<string, unknown>;
  }>;
}

/** All manifests keyed by provider id. */
export const manifests: Record<string, Manifest> = {
  atlassian,
  aws,
  azure,
  'brave-search': braveSearch,
  cloudflare,
  elasticsearch,
  everart,
  everything,
  fetch,
  figma,
  filesystem,
  firebase,
  git,
  github,
  gitlab,
  'google-drive': googleDrive,
  'google-maps': googleMaps,
  linear,
  memory,
  mongodb,
  notion,
  postgres,
  puppeteer,
  redis,
  sentry,
  'sequential-thinking': sequentialThinking,
  slack,
  sqlite,
  stripe,
  time,
};

/** All manifests as an array. */
export const manifestList: Manifest[] = Object.values(manifests);

/** All manifest ids. */
export const manifestIds: string[] = Object.keys(manifests);
