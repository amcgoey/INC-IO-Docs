export function buildHomepageCard() {
  return {
    action: {
      navigations: [
        {
          pushCard: {
            header: {
              title: 'INC-IO Docs',
            },
            sections: [
              {
                widgets: [
                  {
                    buttonList: {
                      buttons: [
                        {
                          text: 'Move Selected File',
                          onClick: {
                            action: {
                              actionMethodName: 'moveSelectedFile',
                            },
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        },
      ],
    },
  };
}

export function buildToastNotification(fileName: string, destinationFolder: string) {
  return {
    action: {
      notification: {
        text: `Moved '${fileName}' to '${destinationFolder}'`,
      },
    },
  };
}

export function buildErrorCard(errorMessage: string, title = 'Error') {
  return {
    action: {
      navigations: [
        {
          pushCard: {
            header: {
              title,
            },
            sections: [
              {
                widgets: [
                  {
                    textParagraph: {
                      text: errorMessage,
                    },
                  },
                ],
              },
            ],
          },
        },
      ],
      notification: {
        text: errorMessage,
      },
    },
  };
}

export function buildAuthorizationAction(
  authorizationUrl = 'https://accounts.google.com/o/oauth2/v2/auth'
) {
  return {
    action: {
      authorizationAction: {
        authorizationUrl,
      },
    },
  };
}

