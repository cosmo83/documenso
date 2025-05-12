import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { S3ClientConfig } from '@aws-sdk/client-s3';
import slugify from '@sindresorhus/slugify';
import path from 'node:path';

import { env } from '@documenso/lib/utils/env';

import { ONE_HOUR, ONE_SECOND } from '../../constants/time';
import { alphaid } from '../id';


// Helper function to parse VCAP_SERVICES
const getS3ConfigFromVcap = () => {
  if (!process.env.VCAP_SERVICES) return null;

  try {
    const vcapServices = JSON.parse(process.env.VCAP_SERVICES);

    const s3Service = vcapServices['aws-s3']?.[0]?.credentials ||
                     vcapServices['s3']?.[0]?.credentials ||
                     vcapServices['objectstore']?.[0]?.credentials;

    if (s3Service) {
      return {
        bucketName: s3Service.bucket_name || s3Service.bucket,
        region: s3Service.region,
        accessKey: s3Service.access_key_id,
        secretKey: s3Service.secret_access_key,
        endpoint: s3Service.endpoint
      };
    }
  } catch (e) {
    console.error('Failed to parse VCAP_SERVICES', e);
  }
  return null;
};

const getS3Client = () => {
  const NEXT_PUBLIC_UPLOAD_TRANSPORT = env('NEXT_PUBLIC_UPLOAD_TRANSPORT');
  
  if (NEXT_PUBLIC_UPLOAD_TRANSPORT !== 's3') {
    throw new Error('Invalid upload transport');
  } 
  
  const vcapConfig = getS3ConfigFromVcap();

  const BUCKET_NAME = vcapConfig?.bucketName || process.env.NEXT_PRIVATE_S3_BUCKET;
  const REGION = vcapConfig?.region || process.env.NEXT_PRIVATE_S3_REGION;
  const ACCESS_KEY = vcapConfig?.accessKey || process.env.NEXT_PRIVATE_S3_ACCESS_KEY;
  const SECRET_KEY = vcapConfig?.secretKey || process.env.NEXT_PRIVATE_S3_SECRET_KEY;
  const ENDPOINT = vcapConfig?.endpoint || process.env.NEXT_PRIVATE_S3_ENDPOINT;

  if (!BUCKET_NAME || !REGION || !ACCESS_KEY || !SECRET_KEY) {
    throw new Error(
      'Missing S3 credentials. Please configure VCAP_SERVICES with S3 service or set environment variables.',
    );
  }

  const clientConfig = {
    region: REGION,
    credentials: {
      accessKeyId: ACCESS_KEY,
      secretAccessKey: SECRET_KEY,
    },
    ...(ENDPOINT && {
      endpoint: ENDPOINT,
      forcePathStyle: true
    })
  };

  return new S3Client(clientConfig);
};


export const getPresignPostUrl = async (fileName: string, contentType: string, userId?: number) => {
  const client = getS3Client();

  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');

  // Get the basename and extension for the file
  const { name, ext } = path.parse(fileName);

  let key = `${alphaid(12)}/${slugify(name)}${ext}`;

  if (userId) {
    key = `${userId}/${key}`;
  }

  const putObjectCommand = new PutObjectCommand({
    Bucket: env('NEXT_PRIVATE_UPLOAD_BUCKET'),
    Key: key,
    ContentType: contentType,
  });

  const url = await getSignedUrl(client, putObjectCommand, {
    expiresIn: ONE_HOUR / ONE_SECOND,
  });

  return { key, url };
};

export const getAbsolutePresignPostUrl = async (key: string) => {
  const client = getS3Client();

  const { getSignedUrl: getS3SignedUrl } = await import('@aws-sdk/s3-request-presigner');

  const putObjectCommand = new PutObjectCommand({
    Bucket: env('NEXT_PRIVATE_UPLOAD_BUCKET'),
    Key: key,
  });

  const url = await getS3SignedUrl(client, putObjectCommand, {
    expiresIn: ONE_HOUR / ONE_SECOND,
  });

  return { key, url };
};

export const getPresignGetUrl = async (key: string) => {
  if (env('NEXT_PRIVATE_UPLOAD_DISTRIBUTION_DOMAIN')) {
    const distributionUrl = new URL(key, `${env('NEXT_PRIVATE_UPLOAD_DISTRIBUTION_DOMAIN')}`);

    const { getSignedUrl: getCloudfrontSignedUrl } = await import('@aws-sdk/cloudfront-signer');

    const url = getCloudfrontSignedUrl({
      url: distributionUrl.toString(),
      keyPairId: `${env('NEXT_PRIVATE_UPLOAD_DISTRIBUTION_KEY_ID')}`,
      privateKey: `${env('NEXT_PRIVATE_UPLOAD_DISTRIBUTION_KEY_CONTENTS')}`,
      dateLessThan: new Date(Date.now() + ONE_HOUR).toISOString(),
    });

    return { key, url };
  }

  const client = getS3Client();

  const { getSignedUrl: getS3SignedUrl } = await import('@aws-sdk/s3-request-presigner');

  const getObjectCommand = new GetObjectCommand({
    Bucket: env('NEXT_PRIVATE_UPLOAD_BUCKET'),
    Key: key,
  });

  const url = await getS3SignedUrl(client, getObjectCommand, {
    expiresIn: ONE_HOUR / ONE_SECOND,
  });

  return { key, url };
};

/**
 * Uploads a file to S3.
 */
export const uploadS3File = async (file: File) => {
  const client = getS3Client();

  // Get the basename and extension for the file
  const { name, ext } = path.parse(file.name);

  const key = `${alphaid(12)}/${slugify(name)}${ext}`;

  const fileBuffer = await file.arrayBuffer();

  const response = await client.send(
    new PutObjectCommand({
      Bucket: env('NEXT_PRIVATE_UPLOAD_BUCKET'),
      Key: key,
      Body: Buffer.from(fileBuffer),
      ContentType: file.type,
    }),
  );

  return { key, response };
};

export const deleteS3File = async (key: string) => {
  const client = getS3Client();

  await client.send(
    new DeleteObjectCommand({
      Bucket: env('NEXT_PRIVATE_UPLOAD_BUCKET'),
      Key: key,
    }),
  );
};

