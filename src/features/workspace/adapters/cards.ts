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
    renderActions: {
      action: {
        notification: {
          text: `Moved '${fileName}' to '${destinationFolder}'`,
        },
      },
    },
  };
}
