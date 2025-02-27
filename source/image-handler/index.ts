// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import Rekognition from "aws-sdk/clients/rekognition";
import S3 from "aws-sdk/clients/s3";
import SecretsManager from "aws-sdk/clients/secretsmanager";

import { getOptions } from '../solution-utils/get-options';
import { isNullOrWhiteSpace } from '../solution-utils/helpers';
import { ImageHandler } from './image-handler';
import { ImageRequest } from './image-request';
import { Headers, ImageHandlerEvent, ImageHandlerExecutionResult, ImageRequestInfo, StatusCodes } from './lib';
import { SecretProvider } from './secret-provider';

const awsSdkOptions = getOptions();
const s3Client = new S3(awsSdkOptions);
const rekognitionClient = new Rekognition(awsSdkOptions);
const secretsManagerClient = new SecretsManager(awsSdkOptions);
const secretProvider = new SecretProvider(secretsManagerClient);

/**
 * Image handler Lambda handler.
 * @param event The image handler request event.
 * @returns Processed request response.
 */
export async function handler(event: ImageHandlerEvent): Promise<ImageHandlerExecutionResult> {
  console.info("Received event:", JSON.stringify(event, null, 2));

  const imageRequest = new ImageRequest(s3Client, secretProvider);
  const imageHandler = new ImageHandler(s3Client, rekognitionClient);
  const isAlb = event.requestContext && Object.prototype.hasOwnProperty.call(event.requestContext, "elb");

  let imageRequestInfo: ImageRequestInfo = {} as ImageRequestInfo;

  try {
    imageRequestInfo = await imageRequest.setup(event);
    console.info(imageRequestInfo);

    // Redirect if no edits but a picture is provided
    if (Object.keys(imageRequestInfo.edits).length === 0 && imageRequestInfo.key !== '') {
      console.info('no edits provided, fallback to highres cdn.')
      return getRedirectResponse(imageRequestInfo);
    }

    const processedRequest = await imageHandler.process(imageRequestInfo);

    let headers = getResponseHeaders(false, isAlb);
    headers["Content-Type"] = imageRequestInfo.contentType;
    // eslint-disable-next-line dot-notation
    headers["Expires"] = imageRequestInfo.expires;
    headers["Last-Modified"] = imageRequestInfo.lastModified;
    headers["Cache-Control"] = imageRequestInfo.cacheControl;

    // Apply the custom headers overwriting any that may need overwriting
    if (imageRequestInfo.headers) {
      headers = { ...headers, ...imageRequestInfo.headers };
    }

    return {
      statusCode: StatusCodes.OK,
      isBase64Encoded: true,
      headers,
      body: processedRequest,
    };
  } catch (error) {
    console.error(error);

    // Fallback to highres cdn if image is too large
    if (error.code === 'TooLargeImageException') {
      return getRedirectResponse(imageRequestInfo);
    }

    // Default fallback image
    const { ENABLE_DEFAULT_FALLBACK_IMAGE, DEFAULT_FALLBACK_IMAGE_BUCKET, DEFAULT_FALLBACK_IMAGE_KEY } = process.env;
    if (
      ENABLE_DEFAULT_FALLBACK_IMAGE === "Yes" &&
      !isNullOrWhiteSpace(DEFAULT_FALLBACK_IMAGE_BUCKET) &&
      !isNullOrWhiteSpace(DEFAULT_FALLBACK_IMAGE_KEY)
    ) {
      try {
        const defaultFallbackImage = await s3Client
          .getObject({
            Bucket: DEFAULT_FALLBACK_IMAGE_BUCKET,
            Key: DEFAULT_FALLBACK_IMAGE_KEY,
          })
          .promise();

        const headers = getResponseHeaders(false, isAlb);
        headers["Content-Type"] = defaultFallbackImage.ContentType;
        headers["Last-Modified"] = defaultFallbackImage.LastModified;
        headers["Cache-Control"] = "max-age=31536000,public";

        return {
          statusCode: error.status ? error.status : StatusCodes.INTERNAL_SERVER_ERROR,
          isBase64Encoded: true,
          headers,
          body: defaultFallbackImage.Body.toString("base64"),
        };
      } catch (error) {
        console.error("Error occurred while getting the default fallback image.", error);
      }
    }

    if (error.status) {
      return {
        statusCode: error.status,
        isBase64Encoded: false,
        headers: getResponseHeaders(true, isAlb),
        body: JSON.stringify(error),
      };
    } else {
      return {
        statusCode: StatusCodes.INTERNAL_SERVER_ERROR,
        isBase64Encoded: false,
        headers: getResponseHeaders(true, isAlb),
        body: JSON.stringify({
          message: "Internal error. Please contact the system administrator.",
          code: "InternalError",
          status: StatusCodes.INTERNAL_SERVER_ERROR,
        }),
      };
    }
  }
}

/**
 * Generates the appropriate set of response headers based on a success or error condition.
 * @param isError Has an error been thrown.
 * @param isAlb Is the request from ALB.
 * @returns Headers.
 */
function getResponseHeaders(isError: boolean = false, isAlb: boolean = false): Headers {
  const { CORS_ENABLED, CORS_ORIGIN } = process.env;
  const corsEnabled = CORS_ENABLED === "Yes";
  const headers: Headers = {
    "Access-Control-Allow-Methods": "GET",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };

  if (!isAlb) {
    headers["Access-Control-Allow-Credentials"] = true;
  }

  if (corsEnabled) {
    headers["Access-Control-Allow-Origin"] = CORS_ORIGIN;
  }

  if (isError) {
    headers["Content-Type"] = "application/json";
  }

  return headers;
}

/**
 * Returns the redirect headers to our highres cdn
 * @param imageRequestInfo 
 * @returns Headers.
 */
function getRedirectResponse(imageRequestInfo: ImageRequestInfo): ImageHandlerExecutionResult {
  return {
    statusCode: StatusCodes.MOVED,
    isBase64Encoded: false,
    headers: {
      "Location": `${process.env.HIGHRES_CDN_URL}/${imageRequestInfo.key}`,
    },
    body: null
  }
}
